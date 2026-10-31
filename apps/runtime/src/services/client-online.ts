import { createHash } from "node:crypto";

import {
  CLIENT_ACTIVITY_LOST_MINUTES,
  CLIENT_ONLINE_MAX_ITEMS,
  CLIENT_ONLINE_PROBE_EVERY_SECONDS,
  CLIENT_ONLINE_PROBE_MAX,
  IN_CONVERSATION_MINUTES,
  type ClientOnlineAttemptBody,
  type ClientOnlineAttemptResponse,
  type ClientOnlinePresenceBody,
  type ClientOnlinePresenceResponse,
  type ClientOnlineProbeResponse,
  type ClientOnlineQuery,
  type ClientOnlineResponse,
} from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  findVisibleFansByPlatformUserIds,
  insertObservation,
  insertOnlineAttempt,
  listOfapiOnlineNow,
  listOnlineCandidates,
  listOnlineProbeCandidates,
  listRecentPageAuthors,
  upsertFanPageExternalPresences,
  type Database,
} from "@agency_hub_core/db";
import {
  CHATSPACE_EXTERNAL_PRESENCE_SOURCE_ONLINE,
  FANSLY_EXTERNAL_PRESENCE_SOURCE_EXTENSION_LAST_SEEN,
  type ExternalPresenceSource,
  type Platform,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { decideOnline, greetingNameOf, onlineRank, ONLINE_RULES, ONLINE_TEMPLATES, type OthersTalking } from "./client-online-rules.ts";
import { inConversationOf } from "./client-in-conversation.ts";
import { clientTokenIngestProducer } from "./client-token-profile.ts";
import { requireClientFeatureOnLabel, requireClientGrantedPage, type ClientFeatureRequest } from "./client-switches.ts";
import { ClientFeatureDisabledError, ConflictError } from "./errors.ts";
import { ingestProducerForClientVersion } from "./ingest-observations.ts";

/**
 * chat-extension «Онлайн»: the page's fans seen online recently, why to write
 * to each now and with what (`clientOnline`), the fans a chatter's tab saw
 * online (`clientOnlinePresence`: Fansly's followers active lately, the fans
 * OnlyMonster's ChatSpace found online), the page's one bounded probe lent to
 * one tab of the team at a time (`clientOnlineProbe`, OnlyFans), and what the
 * chatters did in the window (`clientOnlineAttempt`). The rules are
 * client-online-rules.ts.
 *
 * Database only: nothing here asks a platform or sends anything.
 */

export const ONLINE_FEATURE = "online";
export const ONLINE_PRESENCE_OBSERVATION_KIND = "client.online_presence.v1";
export const ONLINE_ATTEMPT_OBSERVATION_KIND = "client.online_attempt.v1";
/** How far back OnlyFansAPI's own online state is read: a session longer than this is not «online now». */
const ONLINE_NOW_HOURS = 3;
/** A tab's moment this far ahead of Hub's clock is a skew, beyond it a wrong one. */
const PRESENCE_SKEW_MS = 60_000;
/**
 * Whose word a tab's report is, by the page's platform: Fansly's own `lastSeenAt` of the creator's followers, or
 * OnlyMonster's ChatSpace saying the fan is online. Another platform takes no report.
 */
const TAB_PRESENCE_SOURCES: Readonly<Partial<Record<Platform, ExternalPresenceSource>>> = {
  fansly: FANSLY_EXTERNAL_PRESENCE_SOURCE_EXTENSION_LAST_SEEN,
  onlyfans: CHATSPACE_EXTERNAL_PRESENCE_SOURCE_ONLINE,
};

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

function producerOf(request: { headers: Record<string, string | string[] | undefined> }, principal: HumanAuthPrincipal) {
  const header = request.headers["x-client-version"];
  const clientVersion = typeof header === "string" ? header : null;
  return principal.clientProfile === undefined
    ? ingestProducerForClientVersion(clientVersion ?? "unknown")
    : clientTokenIngestProducer(principal.clientProfile, clientVersion);
}

export async function readClientOnline(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; query: ClientOnlineQuery },
): Promise<ClientOnlineResponse> {
  // A cookie session → 403: the list is a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), ONLINE_FEATURE);
  const now = new Date();
  const online = page.platform === "onlyfans" ? await listOfapiOnlineNow(app.db, { pageId: page.id, now, hours: ONLINE_NOW_HOURS }) : [];
  const [rows, authors] = await Promise.all([
    listOnlineCandidates(app.db, {
      pageId: page.id, platform: page.platform, now, minutes: input.query.minutes, onlineRefs: online.map((one) => one.fanRef), limit: CLIENT_ONLINE_MAX_ITEMS,
    }),
    listRecentPageAuthors(app.db, { pageId: page.id, now, minutes: IN_CONVERSATION_MINUTES, lostMinutes: CLIENT_ACTIVITY_LOST_MINUTES }),
  ]);
  const others = new Map<string, OthersTalking>();
  for (const fan of inConversationOf(authors, principal.user.id)) {
    const chatters = fan.chatters.filter((chatter) => !chatter.isMe);
    if (chatters.length > 0) others.set(fan.fanRef, { names: chatters.map((chatter) => chatter.name), lastSentAt: new Date(chatters[0]!.lastSentAt) });
  }
  const since = new Map(online.map((one) => [one.fanRef, one.since]));
  const fresh = now.getTime() - ONLINE_RULES.freshMinutes * 60_000;
  const items = rows
    .map((row) => {
      const decision = decideOnline(row, { now, others: others.get(row.fanRef) ?? null });
      const onlineSince = since.get(row.fanRef) ?? null;
      return { row, decision, onlineSince, fresh: onlineSince !== null || (row.seenAt !== null && row.seenAt.getTime() > fresh) };
    })
    .sort((a, b) => onlineRank(
      { reason: a.decision.reason, aside: a.decision.aside, fresh: a.fresh, lifetimeGrossMills: a.row.lifetimeGrossMills, seenAt: a.row.seenAt },
      { reason: b.decision.reason, aside: b.decision.aside, fresh: b.fresh, lifetimeGrossMills: b.row.lifetimeGrossMills, seenAt: b.row.seenAt },
    ))
    .map(({ row, decision, onlineSince }) => ({
      fanRef: row.fanRef,
      conversationRef: row.conversationRef,
      username: row.username,
      displayName: row.displayName,
      alias: row.alias,
      greetingName: greetingNameOf(row.displayName, row.username),
      lifetimeGrossMills: row.lifetimeGrossMills,
      last30dGrossMills: row.last30GrossMills,
      seenAt: iso(row.seenAt),
      onlineSince: iso(onlineSince),
      seenSource: row.seenSource,
      reason: decision.reason,
      reasonAt: iso(decision.reasonAt),
      act: decision.act,
      aside: decision.aside,
      asideAt: iso(decision.asideAt),
      asideBy: decision.asideBy,
      messageCount: row.messageCount,
      lastFanMessageAt: iso(row.lastFanMessageAt),
      lastPageMessageAt: iso(row.answeredAt),
      subscription: {
        isSubscriber: row.isSubscriber,
        startedAt: iso(row.subscribedAt),
        endsAt: iso(row.subscriptionEndsAt),
        autoRenew: row.autoRenew,
      },
    }));
  return {
    pageLabel: page.label,
    minutes: input.query.minutes,
    items,
    templates: ONLINE_TEMPLATES.map((template) => ({ ...template })),
    serverNow: now.toISOString(),
  };
}

export async function recordClientOnlinePresence(
  app: AppContext,
  request: { headers: Record<string, string | string[] | undefined> },
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; body: ClientOnlinePresenceBody },
): Promise<ClientOnlinePresenceResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), ONLINE_FEATURE);
  const source = TAB_PRESENCE_SOURCES[page.platform];
  if (source === undefined) throw new ClientFeatureDisabledError(ONLINE_FEATURE, "platform_unsupported");
  const now = new Date();
  const latest = new Map<string, Date>();
  for (const entry of input.body.seen) {
    const at = new Date(entry.lastSeenAt);
    if (at.getTime() > now.getTime() + PRESENCE_SKEW_MS) continue;
    const known = latest.get(entry.fanRef);
    if (known === undefined || at > known) latest.set(entry.fanRef, at);
  }
  const fans = latest.size === 0 ? [] : await findVisibleFansByPlatformUserIds(app.db, {
    platform: page.platform, platformUserIds: [...latest.keys()], pageIds: [page.id],
  });
  const kept = fans.flatMap((fan) => {
    const at = latest.get(fan.platformUserId);
    return at === undefined ? [] : [{ fanId: fan.fanId, fanRef: fan.platformUserId, at: at.getTime() > now.getTime() ? now : at }];
  });
  if (kept.length > 0) {
    const producer = producerOf(request, principal);
    await app.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      // Its own small fact (owner ruling A20: a fan's lastSeenAt never rides a capture body).
      const payload = {
        pageLabel: page.label,
        seen: kept.map((one) => ({ fanRef: one.fanRef, lastSeenAt: one.at.toISOString() })),
        reportedAt: now.toISOString(),
      };
      await insertObservation(tx, {
        source: "client_capture",
        producer,
        platform: page.platform,
        accountId: page.id,
        kind: ONLINE_PRESENCE_OBSERVATION_KIND,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `${principal.user.id}:online_presence:${page.id}:${now.toISOString()}`,
        observedAt: now,
        actorPrincipalId: principal.user.id,
      });
      await upsertFanPageExternalPresences(tx, kept.map((one) => ({
        fanId: one.fanId,
        platformAccountId: page.id,
        externalPresenceAt: one.at,
        externalPresenceObservedAt: now,
        externalPresenceSource: source,
      })));
    });
  }
  return { recorded: kept.length, skipped: input.body.seen.length - kept.length, serverNow: now.toISOString() };
}

/**
 * When each page's probe may be lent next, by page (`clientOnlineProbe`). Kept in this process, by the app: a
 * restart lends a page's probe once more early, one more OnlyMonster read at most.
 */
const probeNextAt = new WeakMap<AppContext, Map<number, number>>();

/**
 * The page's probe of who of its known spenders is online (chat-extension «Онлайн» on OnlyFans), lent to one tab of
 * the whole team at a time: the first caller after the page's last lend plus CLIENT_ONLINE_PROBE_EVERY_SECONDS gets
 * the spenders to ask OnlyMonster about once; everyone else meanwhile is told when. The lend is taken before anything
 * is awaited, so two callers never both get it; a lent probe is never lent again early, whatever became of it.
 */
export async function leaseClientOnlineProbe(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string },
): Promise<ClientOnlineProbeResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientFeatureOnLabel(app, request, principal, input.pageLabel, "onlineProbe");
  const now = new Date();
  const leases = probeNextAt.get(app) ?? new Map<number, number>();
  probeNextAt.set(app, leases);
  const due = leases.get(page.id) ?? 0;
  if (now.getTime() < due) {
    return { granted: false, fanRefs: [], nextAt: new Date(due).toISOString(), serverNow: now.toISOString() };
  }
  const nextAt = now.getTime() + CLIENT_ONLINE_PROBE_EVERY_SECONDS * 1000;
  leases.set(page.id, nextAt);
  const fanRefs = await listOnlineProbeCandidates(app.db, { pageId: page.id, limit: CLIENT_ONLINE_PROBE_MAX });
  return { granted: true, fanRefs, nextAt: new Date(nextAt).toISOString(), serverNow: now.toISOString() };
}

export async function recordClientOnlineAttempt(
  app: AppContext,
  request: { headers: Record<string, string | string[] | undefined> },
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; body: ClientOnlineAttemptBody },
): Promise<ClientOnlineAttemptResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), ONLINE_FEATURE);
  const [fan] = await findVisibleFansByPlatformUserIds(app.db, { platform: page.platform, platformUserIds: [input.body.fanRef], pageIds: [page.id] });
  if (fan === undefined) throw new ConflictError("The fan is not linked to the page", { reason: "not_listed" });
  const now = new Date();
  const sent = input.body.action === "sent";
  const act = sent ? input.body.act ?? null : null;
  const templateId = sent && act === "template" ? input.body.templateId ?? null : null;
  const reason = input.body.reason ?? null;
  const producer = producerOf(request, principal);
  const attemptId = await app.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const payload = { pageLabel: page.label, fanRef: fan.platformUserId, action: input.body.action, act, templateId, reason, at: now.toISOString() };
    const journaled = await insertObservation(tx, {
      source: "client_capture",
      producer,
      platform: page.platform,
      accountId: page.id,
      kind: ONLINE_ATTEMPT_OBSERVATION_KIND,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `${principal.user.id}:online_attempt:${page.id}:${fan.platformUserId}:${input.body.action}:${now.toISOString()}`,
      observedAt: now,
      actorPrincipalId: principal.user.id,
    });
    return insertOnlineAttempt(tx, {
      pageId: page.id, fanId: fan.fanId, fanRef: fan.platformUserId, conversationRef: null, userId: principal.user.id,
      action: input.body.action, act, templateId, reason, attemptedAt: now, observationId: journaled.observationId,
    });
  });
  return { attemptId };
}
