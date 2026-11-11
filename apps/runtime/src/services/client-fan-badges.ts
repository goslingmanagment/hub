import { createHash } from "node:crypto";

import type { ClientFanBadgesBody, ClientFanBadgesResponse, ClientFbuddyTier } from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  findVisibleFansByPlatformUserIds,
  insertObservation,
  readFanBadges,
  writeFanBadges,
  type Database,
  type FanBadgeStoredTier,
  type FanBadgesWrite,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { stampOnlyParseVersion } from "./canonicalize/index.ts";
import { requireClientGrantedPage } from "./client-switches.ts";
import { ClientFeatureDisabledError } from "./errors.ts";
import { clientCaptureProducer } from "./ingest-observations.ts";

/**
 * chat-extension's fan badges (`clientFanBadges`): FBuddy's spending tier and Fansly's «Recent Spender» mark of a
 * Fansly page's fans, as a chatter's browser read them. Hub reads neither itself. A badge is the fan's, not the page's
 * (fan_badges, 0373); agents read it in the `fan_memberships` dataset.
 *
 * Every open board of every chatter reports its fans every few minutes, so the steady state must cost nothing: a value
 * Hub already has, confirmed less than a day ago, writes no row and journals nothing. A change is journaled first (one
 * observation per report, only the changed fans and fields), then kept with the moment of the change.
 *
 * Database only: nothing here asks a platform or sends anything.
 */

export const FAN_BADGES_FEATURE = "fan-badges";
export const FAN_BADGES_OBSERVATION_KIND = "client.fan_badges.v1";
/** An unchanged badge moves its `*_checked_at` at most this often. */
const CONFIRM_EVERY_MS = 24 * 60 * 60_000;

/** What a report says of one fan; undefined: that source was not read. */
interface ReportedBadges {
  tier: FanBadgeStoredTier | undefined;
  recentSpender: boolean | undefined;
}

/** The journal's entry of a fan: only its changed badges, as the client sent them (`fbuddyTier: null` — FBuddy has none). */
interface JournaledBadges {
  fanRef: string;
  fbuddyTier?: ClientFbuddyTier | null;
  recentSpender?: boolean;
}

const wireTierOf = (tier: FanBadgeStoredTier): ClientFbuddyTier | null => (tier === "none" ? null : tier);

export async function recordClientFanBadges(
  app: AppContext,
  request: { headers: Record<string, string | string[] | undefined> },
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; body: ClientFanBadgesBody },
): Promise<ClientFanBadgesResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), FAN_BADGES_FEATURE);
  if (page.platform !== "fansly") throw new ClientFeatureDisabledError(FAN_BADGES_FEATURE, "platform_unsupported");
  const now = new Date();

  // One entry per fan, the last one wins; an entry with neither badge says nothing.
  const reported = new Map<string, ReportedBadges>();
  for (const entry of input.body.fans) {
    reported.set(entry.fanRef, {
      tier: entry.fbuddyTier === undefined ? undefined : entry.fbuddyTier ?? "none",
      recentSpender: entry.recentSpender,
    });
  }
  const refs = [...reported].flatMap(([fanRef, badges]) => (
    badges.tier === undefined && badges.recentSpender === undefined ? [] : [fanRef]
  ));
  const fans = refs.length === 0 ? [] : await findVisibleFansByPlatformUserIds(app.db, {
    platform: page.platform, platformUserIds: refs, pageIds: [page.id],
  });
  const stored = await readFanBadges(app.db, fans.map((fan) => fan.fanId));

  // Per field: changed — Hub has no value or another one; due — changed, or the same value confirmed over a day ago.
  const confirmBefore = new Date(now.getTime() - CONFIRM_EVERY_MS);
  const stale = (checkedAt: Date | null | undefined) => checkedAt == null || checkedAt < confirmBefore;
  const journaled: JournaledBadges[] = [];
  const writes: FanBadgesWrite[] = [];
  let linked = 0;
  for (const fan of fans) {
    const badges = reported.get(fan.platformUserId);
    if (badges === undefined) continue;
    linked += 1;
    const row = stored.get(fan.fanId);
    const { tier, recentSpender } = badges;
    const tierChanged = tier !== undefined && row?.fbuddyTier !== tier;
    const spenderChanged = recentSpender !== undefined && row?.recentSpender !== recentSpender;
    const tierDue = tier !== undefined && (tierChanged || stale(row?.fbuddyTierCheckedAt));
    const spenderDue = recentSpender !== undefined && (spenderChanged || stale(row?.recentSpenderCheckedAt));
    if (tierChanged || spenderChanged) {
      journaled.push({
        fanRef: fan.platformUserId,
        ...(tierChanged ? { fbuddyTier: wireTierOf(tier) } : {}),
        ...(spenderChanged ? { recentSpender } : {}),
      });
    }
    if (tierDue || spenderDue) {
      writes.push({
        fanId: fan.fanId,
        ...(tierDue ? { fbuddyTier: tier } : {}),
        ...(spenderDue ? { recentSpender } : {}),
      });
    }
  }

  if (writes.length > 0) {
    const header = request.headers["x-client-version"];
    const producer = clientCaptureProducer(principal, typeof header === "string" ? header : null);
    await app.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      if (journaled.length > 0) {
        const payload = { pageLabel: page.label, fans: journaled, reportedAt: now.toISOString() };
        await insertObservation(tx, {
          source: "client_capture",
          producer,
          platform: page.platform,
          accountId: page.id,
          kind: FAN_BADGES_OBSERVATION_KIND,
          parseVersion: stampOnlyParseVersion("client_capture", FAN_BADGES_OBSERVATION_KIND),
          payload,
          payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
          idempotencyKey: `${principal.user.id}:fan_badges:${page.id}:${now.toISOString()}`,
          observedAt: now,
          actorPrincipalId: principal.user.id,
        });
      }
      await writeFanBadges(tx, { now, confirmBefore, fans: writes });
    });
  }

  return {
    changed: journaled.length,
    unchanged: linked - journaled.length,
    skipped: reported.size - linked,
    serverNow: now.toISOString(),
  };
}
