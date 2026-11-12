import { createHash } from "node:crypto";

import type { ClientFanBadgesBody, ClientFanBadgesResponse, ClientFbuddyTier } from "@agency_hub_core/contracts";
import {
  clientAccountSignalIsNews,
  findPageSummaryByLabel,
  findVisibleFansByPlatformUserIds,
  insertObservation,
  readFanBadges,
  readFanPageAccountAnswers,
  recordFanPageClientAccountSignals,
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
 * `accountSeen` (fan-account-state-v1, 0374): whether the page's session returned the fan's account to the tab
 * (`GET /account?ids=`). It is a signal, never the page's answer — `page_fans.account_probe_*` takes a fan out of the
 * fan queues and the outreach audiences, so only the page's own read writes it. Only a word that DISAGREES with the
 * page's stored answer (not seen while the page sees him or never asked; seen while the page does not) is journaled,
 * in the same observation, and kept on the page link with Hub's clock (`account_client_seen*`), which makes the page's
 * re-check (`fan-profiles.recheck`) due; the same word again while the page has not answered since is nothing. Its fans
 * are every fan linked to the page, the legacy-marked ones too (`readFanPageAccountAnswers`); the badges keep theirs.
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
  accountSeen: boolean | undefined;
}

/** The journal's entry of a fan: only its changed badges, as the client sent them (`fbuddyTier: null` — FBuddy has none),
 *  and `accountSeen` when it disagreed with the page's answer. */
interface JournaledBadges {
  fanRef: string;
  fbuddyTier?: ClientFbuddyTier | null;
  recentSpender?: boolean;
  accountSeen?: boolean;
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

  // One entry per fan, the last one wins; an entry with nothing says nothing.
  const reported = new Map<string, ReportedBadges>();
  for (const entry of input.body.fans) {
    reported.set(entry.fanRef, {
      tier: entry.fbuddyTier === undefined ? undefined : entry.fbuddyTier ?? "none",
      recentSpender: entry.recentSpender,
      accountSeen: entry.accountSeen,
    });
  }
  const refs = [...reported].flatMap(([fanRef, badges]) => (
    badges.tier === undefined && badges.recentSpender === undefined ? [] : [fanRef]
  ));
  const fans = refs.length === 0 ? [] : await findVisibleFansByPlatformUserIds(app.db, {
    platform: page.platform, platformUserIds: refs, pageIds: [page.id],
  });
  const stored = await readFanBadges(app.db, fans.map((fan) => fan.fanId));

  // The browser's word on each account, against the page's own answer: every fan linked to the page.
  const signalRefs = [...reported].flatMap(([fanRef, badges]) => (badges.accountSeen === undefined ? [] : [fanRef]));
  const links = signalRefs.length === 0 ? [] : await readFanPageAccountAnswers(app.db, {
    pageId: page.id, platform: page.platform, platformUserIds: signalRefs,
  });
  const signals: Array<{ fanId: number; fanRef: string; seen: boolean }> = [];
  for (const link of links) {
    const seen = reported.get(link.platformUserId)?.accountSeen;
    if (seen !== undefined && clientAccountSignalIsNews(seen, link)) signals.push({ fanId: link.fanId, fanRef: link.platformUserId, seen });
  }

  // Per field: changed — Hub has no value or another one; due — changed, or the same value confirmed over a day ago.
  const confirmBefore = new Date(now.getTime() - CONFIRM_EVERY_MS);
  const stale = (checkedAt: Date | null | undefined) => checkedAt == null || checkedAt < confirmBefore;
  const journaled: JournaledBadges[] = [];
  const writes: FanBadgesWrite[] = [];
  for (const fan of fans) {
    const badges = reported.get(fan.platformUserId);
    if (badges === undefined) continue;
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

  // A disagreeing word joins its fan's entry in the journal (one entry per fan).
  const changedFans = journaled.length;
  for (const signal of signals) {
    const entry = journaled.find((candidate) => candidate.fanRef === signal.fanRef);
    if (entry === undefined) journaled.push({ fanRef: signal.fanRef, accountSeen: signal.seen });
    else entry.accountSeen = signal.seen;
  }

  if (writes.length > 0 || signals.length > 0) {
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
      if (writes.length > 0) await writeFanBadges(tx, { now, confirmBefore, fans: writes });
      // Never the page's answer: only the signal columns of the page link.
      await recordFanPageClientAccountSignals(tx, { pageId: page.id, at: now, signals });
    });
  }

  // A fan counts once: linked by its badges or by its page link.
  const linkedRefs = new Set([...fans.map((fan) => fan.platformUserId), ...links.map((link) => link.platformUserId)]);
  return {
    changed: changedFans,
    unchanged: linkedRefs.size - changedFans,
    skipped: reported.size - linkedRefs.size,
    accountSignals: signals.length,
    serverNow: now.toISOString(),
  };
}
