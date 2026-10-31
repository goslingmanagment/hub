import { createHash } from "node:crypto";

import {
  CLIENT_ONLYFANS_FEED_MAX_AGE_DAYS,
  CLIENT_ONLYFANS_FEED_MAX_AHEAD_MS,
  clientOnlyfansFeedRecordSchema,
  type ClientOnlyfansFeedBody,
  type ClientOnlyfansFeedFanFacts,
  type ClientOnlyfansFeedMessage,
  type ClientOnlyfansFeedRecord,
  type ClientOnlyfansFeedResponse,
} from "@agency_hub_core/contracts";
import {
  advanceOnlyfansFeedPollCursor,
  findPageSummaryByLabel,
  getPageTransactionsWriterInfo,
  insertObservation,
  listOnlyfansFeedMoneyObservations,
  markPageDmMessagePurchased,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  setOnlyfansFeedTransactionsWriter,
  setPageDmConversationUnreadCount,
  setPageFanPlatformSpend,
  upsertArchivedPageSubscriptions,
  upsertFanPages,
  upsertFans,
  upsertPageSubscriptions,
  withOfapiSpendTransactionPageLock,
  type ClientBootstrapPageRow,
  type Database,
} from "@agency_hub_core/db";
import { dollarsToMills, millsFromDollars, millsToWholeCents, normalizeDmMessageText } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { CLIENT_ONLYFANS_FEED_OBSERVATION_KIND } from "./canonicalize/client-onlyfans-feed.ts";
import {
  applyFeedMoneySighting,
  feedDollarsToMills,
  ledgerKindOf,
  ppvKindOf,
  socketNetMills,
  type FeedMoneySightingInput,
} from "./client-onlyfans-feed-money.ts";
import { loadClientSwitches, requireClientFeatureOnLabel, type ClientFeatureRequest } from "./client-switches.ts";
import { clientTokenIngestProducer } from "./client-token-profile.ts";
import { clientVersionOf } from "./client-send-attributions.ts";
import { ClientFeatureDisabledError, ServiceUnavailableError } from "./errors.ts";
import { ingestProducerForClientVersion } from "./ingest-observations.ts";
import {
  projectDmMessageDeletedInTransaction,
  projectDmMessageInTransaction,
  truncatePreview,
  type OfapiProjectedDmMessage,
} from "./ofapi-dm-projection.ts";
import { assertPageTransactionsWriter } from "./transactions-writer-gate.ts";

/**
 * The OnlyFans feed from ChatSpace (`clientOnlyfansFeed`, capability
 * `onlyfans-feed-v1`, the page's `ofFeed`).
 *
 * From 2026-11-01 the hub has no OnlyFansAPI. The chatters keep working in
 * OnlyMonster ChatSpace, and the chat extension there passes on what the page
 * itself already received — its socket's frames and the answers of its own
 * reads — so the archive, the page's chats, its money and its fans stay fresh
 * and every feature that reads them works as before. The client makes no
 * request of its own for it, and nothing here asks a platform.
 *
 * WHO MAY REPORT. A device token (a cookie session is 403) for an active
 * OnlyFans page granted to the caller with its `ofFeed` on; the report's
 * OnlyMonster account must be the page's: its OnlyFans creator is the page's
 * own account, or the owner bound that host account to the page — else 409
 * `binding_mismatch`. The person is the token's user, never a field of the body.
 *
 * JOURNAL FIRST. Every record is one `observations` row of kind
 * `client.onlyfans_feed.v1` under the reporting person, keyed by the page,
 * OnlyFans' id of the thing and the record's content: the same thing reported
 * again by any tab, with nothing changed, is a `duplicate` and writes nothing.
 * A record and what it writes commit together.
 *
 * WHAT IT WRITES.
 * - A message: the archive (message_archive) through its message events
 *   (canonicalize/client-onlyfans-feed.ts, the next sweep), and the page's
 *   chats here (page_dm_threads / page_dm_messages, as the webhook did): one
 *   from the socket is news (a fan's adds to the chat's unread count), one from
 *   a history page or a chat list is not. A fan's own facts that came with it
 *   name the fan.
 * - A deletion: the message leaves the page's chats (its tombstone reaches the
 *   archive through `message.deleted`).
 * - A purchase of a message marks it bought (team sales count it); its money
 *   and a tip's go to the page's transactions (client-onlyfans-feed-money.ts),
 *   and so do the sales ledger's rows — only while the page's writer is
 *   `chatspace`. Before that they are journaled and answered `held`;
 *   `onlyfans-feed:take-money` moves the writer and replays them.
 * - A fan: names, the subscription (page_fans, page_subscriptions) and the
 *   platform's own lifetime sums by type (page_fans.platform_spend).
 * - A chat: its unread count as OnlyFans counts it.
 * A record observed more than CLIENT_ONLYFANS_FEED_MAX_AHEAD_MS ahead of the
 * hub's clock or more than CLIENT_ONLYFANS_FEED_MAX_AGE_DAYS old is journaled
 * only (`outOfRange`).
 */

/** How a refusal names the route. */
export const ONLYFANS_FEED_FEATURE = "onlyfans-feed-v1";

const MONEY_KINDS: ReadonlySet<ClientOnlyfansFeedRecord["kind"]> = new Set(["ppv", "tip", "ledger"]);

/** OnlyFans' id of what a record is about: the stable part of its journal key. Pure. */
export function onlyfansFeedRecordKey(record: ClientOnlyfansFeedRecord): string {
  switch (record.kind) {
    case "message":
      return `m:${record.messageRef}`;
    case "deleted":
      return `d:${record.messageRef}`;
    case "ppv":
      return `ppv:${record.contentType}:${record.contentRef}:${record.fanRef}`;
    case "tip":
      return `tip:${record.tipRef}`;
    case "fan":
      return `fan:${record.fanRef}`;
    case "chat":
      return `chat:${record.fanRef}`;
    case "ledger":
      return `tx:${record.transactionRef}`;
    case "subscriber":
      return `sub:${record.notificationRef}`;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * What a record says, apart from when and how the page got it: two tabs that
 * saw the same thing the same way report one fingerprint. Pure.
 */
export function onlyfansFeedRecordFingerprint(record: ClientOnlyfansFeedRecord): string {
  const { observedAt: _observedAt, ...rest } = record;
  const content = rest.kind === "message" ? { ...rest, via: undefined } : rest;
  return createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex").slice(0, 32);
}

/** Whether an observation time is inside what the hub writes from at `now`. Pure. */
export function onlyfansFeedObservedInRange(observedAt: Date, now: Date): boolean {
  const at = observedAt.getTime();
  return !Number.isNaN(at)
    && at <= now.getTime() + CLIENT_ONLYFANS_FEED_MAX_AHEAD_MS
    && at >= now.getTime() - CLIENT_ONLYFANS_FEED_MAX_AGE_DAYS * 24 * 60 * 60_000;
}

/** The message as the page's chats store it. Pure. */
export function onlyfansFeedProjectedMessage(record: ClientOnlyfansFeedMessage, creatorRef: string): OfapiProjectedDmMessage {
  const content = normalizeDmMessageText(record.textHtml);
  const fan = record.fromFan ? record.fan : null;
  const nonEmpty = (value: string | null | undefined) => (typeof value === "string" && value.trim() !== "" ? value : null);
  return {
    direction: record.fromFan ? "received" : "sent",
    messageId: record.messageRef,
    fanId: record.fanRef,
    fanUsername: nonEmpty(fan?.username),
    // OnlyFans user objects carry the fan's own name in `name`; `displayName` is the creator's name for the fan.
    fanDisplayName: nonEmpty(fan?.name) ?? nonEmpty(fan?.displayName),
    senderPlatformUserId: record.fromFan ? record.fanRef : creatorRef,
    content,
    preview: truncatePreview(content),
    createdAt: new Date(record.sentAt),
    tipAmountCents: record.isTip && record.price !== null ? millsToWholeCents(millsFromDollars(record.price)) : 0,
    inReplyToMessageId: null,
    partnerLastSeenAt: null,
  };
}

/** A money record as a sighting of its purchase, or null when it carries no amount the hub counts. Pure. */
export function onlyfansFeedSighting(record: ClientOnlyfansFeedRecord, observationId: number, fanId: number | null): FeedMoneySightingInput | null {
  switch (record.kind) {
    case "ppv": {
      const gross = feedDollarsToMills(record.priceGross);
      if (gross === null || gross <= 0n) return null;
      const purchase = onlyfansFeedPurchaseRef(record);
      return {
        sighting: "ws",
        feedKey: `ws:ppv:${purchase}`,
        transactionId: `chatspace:ppv:${purchase}`,
        fanRef: record.fanRef,
        fanId,
        kind: ppvKindOf(record.contentType),
        grossMills: gross,
        netMills: socketNetMills(gross),
        occurredAt: new Date(record.observedAt),
        chargeback: false,
        rawType: `chatspace:ppv:${record.contentType}`,
        rawStatus: "purchased",
        observationId,
      };
    }
    case "tip": {
      const gross = feedDollarsToMills(record.amountGross);
      if (gross === null || gross <= 0n) return null;
      return {
        sighting: "ws",
        feedKey: `ws:tip:${record.tipRef}`,
        transactionId: `chatspace:tip:${record.tipRef}`,
        fanRef: record.fanRef,
        fanId,
        kind: "tip",
        grossMills: gross,
        netMills: socketNetMills(gross),
        occurredAt: new Date(record.observedAt),
        chargeback: false,
        rawType: "chatspace:tip",
        rawStatus: "received",
        observationId,
      };
    }
    case "ledger": {
      const gross = feedDollarsToMills(Math.abs(record.amountGross));
      const net = feedDollarsToMills(Math.abs(record.amountNet));
      if (gross === null || net === null || gross <= 0n) return null;
      return {
        sighting: "ledger",
        feedKey: `ledger:${record.transactionRef}`,
        transactionId: record.transactionRef,
        fanRef: record.fanRef,
        fanId,
        kind: ledgerKindOf(record.description),
        grossMills: gross,
        netMills: net,
        occurredAt: new Date(record.createdAt),
        chargeback: record.status === "undo",
        rawType: `chatspace:ledger:${ledgerKindOf(record.description)}`,
        rawStatus: record.status ?? "",
        observationId,
      };
    }
    default:
      return null;
  }
}

/** A short one-way digest: what a key names a fan by, never the fan's id itself (fan erasure clears columns, not keys). Pure. */
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * The purchase a socket's PPV names: a message is bought by the one fan it went to; a post by many, so the
 * fan's digest stays with it. Pure.
 */
export function onlyfansFeedPurchaseRef(record: Extract<ClientOnlyfansFeedRecord, { kind: "ppv" }>): string {
  return record.contentType === "message"
    ? `message:${record.contentRef}`
    : `${record.contentType}:${record.contentRef}:${digest(record.fanRef)}`;
}

function fanRefOf(record: ClientOnlyfansFeedRecord): string | null {
  return record.kind === "deleted" ? null : record.kind === "message" ? record.fanRef : record.fanRef ?? null;
}

async function fanRowId(db: Database, pageId: number, fanRef: string, facts: ClientOnlyfansFeedFanFacts | null): Promise<number | null> {
  const username = facts?.username?.trim() ? facts.username : null;
  const displayName = facts?.name?.trim() ? facts.name : facts?.displayName?.trim() ? facts.displayName : null;
  const [fan] = await upsertFans(db, [{
    platform: "onlyfans",
    platformUserId: fanRef,
    ...(username !== null ? { username } : {}),
    ...(displayName !== null ? { displayName } : {}),
  }]);
  if (!fan) return null;
  await upsertFanPages(db, [{ fanId: fan.id, platformAccountId: pageId }]);
  return fan.id;
}

/** A fan as the page's fan read gave it: names, the subscription, the platform's own lifetime sums. */
async function writeFanFacts(db: Database, pageId: number, record: Extract<ClientOnlyfansFeedRecord, { kind: "fan" }>): Promise<void> {
  const fanId = await fanRowId(db, pageId, record.fanRef, record);
  if (fanId === null) return;
  const date = (value: string | null) => (value === null ? null : new Date(value));
  const known = record.subscribedOn !== null;
  if (known) {
    const active = record.subscribedOn === true && record.subscribedOnExpiredNow !== true;
    const priceMills = dollarsToMills(record.subscribePrice ?? 0);
    const subscription = {
      // OnlyFans has one subscription per fan and page, with no id of its own: the fan id is it.
      platformSubscriptionId: record.fanRef,
      platformAccountId: pageId,
      fanId,
      rawStatus: 0,
      canonicalStatus: active ? "active" : "expired",
      priceMills,
      renewPriceMills: record.regularPrice !== null ? dollarsToMills(record.regularPrice) : priceMills,
      // «Set to Expire»: auto-renew is off.
      autoRenew: record.subscriptionStatus === null ? null : record.subscriptionStatus !== "Set to Expire",
      renewDate: date(record.expiredAt),
      sourceCreatedAt: date(record.subscribeAt),
      sourceUpdatedAt: date(record.renewedAt) ?? date(record.subscribeAt),
      endsAt: date(record.expiredAt),
    };
    if (active) await upsertPageSubscriptions(db, [subscription]);
    else await upsertArchivedPageSubscriptions(db, [subscription]);
    await upsertFanPages(db, [{
      fanId,
      platformAccountId: pageId,
      isSubscriber: active,
      subscriberSince: active ? date(record.subscribeAt) : null,
      subscriptionExpiresAt: date(record.expiredAt),
      autoRenew: subscription.autoRenew,
    }]);
  }
  if (record.spend !== null) {
    await setPageFanPlatformSpend(db, { fanId, pageId, spend: { ...record.spend }, observedAt: new Date(record.observedAt) });
  }
}

/** What one new record writes besides its money, inside its own transaction. */
async function writeRecord(db: Database, page: ClientBootstrapPageRow, creatorRef: string, record: ClientOnlyfansFeedRecord, receivedAt: Date): Promise<void> {
  switch (record.kind) {
    case "message": {
      const outcome = await projectDmMessageInTransaction(db, page, onlyfansFeedProjectedMessage(record, creatorRef), receivedAt, {
        live: record.via === "socket",
        provider: "chatspace",
      });
      // An erasure holds the page's fence: nothing of this record commits; the client says it again.
      if (outcome.status === "deferred") throw new ServiceUnavailableError("The page's chats are being erased; try again");
      return;
    }
    case "deleted": {
      await projectDmMessageDeletedInTransaction(db, page, record.messageRef);
      return;
    }
    case "ppv": {
      if (record.contentType === "message") {
        await markPageDmMessagePurchased(db, { platformAccountId: page.id, platformMessageId: record.contentRef, purchasedAt: new Date(record.observedAt) });
      }
      return;
    }
    case "fan":
      await writeFanFacts(db, page.id, record);
      return;
    case "chat":
      if (record.unreadCount !== null) await setPageDmConversationUnreadCount(db, { pageId: page.id, fanRef: record.fanRef, unreadCount: record.unreadCount });
      return;
    case "tip":
      return;
    case "ledger":
      // The poll reads the ledger back to the newest row the hub holds.
      await advanceOnlyfansFeedPollCursor(db, { pageId: page.id, list: "ledger", ref: record.transactionRef, at: new Date(record.createdAt) });
      return;
    case "subscriber":
      // The row of «Новые» comes from its event (the canonicalizer); the poll reads back to the newest notification.
      await advanceOnlyfansFeedPollCursor(db, { pageId: page.id, list: "subscribers", ref: record.notificationRef, at: new Date(record.createdAt) });
      return;
  }
}

/** The report's OnlyMonster account is the page's: its creator is the page's account, or the owner bound it there. */
export async function requireBoundAccount(app: AppContext, page: ClientBootstrapPageRow, body: Pick<ClientOnlyfansFeedBody, "hostAccountRef" | "creatorRef">): Promise<void> {
  if (page.platformAccountId !== null && page.platformAccountId === body.creatorRef) return;
  const switches = await loadClientSwitches(app);
  if (switches.settings.hostBindings[body.hostAccountRef] === page.label) return;
  throw new ClientFeatureDisabledError(ONLYFANS_FEED_FEATURE, "binding_mismatch");
}

interface JournalInput {
  producer: string;
  page: ClientBootstrapPageRow;
  body: ClientOnlyfansFeedBody;
  record: ClientOnlyfansFeedRecord;
  userId: number;
}

async function journal(db: Database, input: JournalInput) {
  const { page, body, record } = input;
  const payload = { pageLabel: page.label, hostAccountRef: body.hostAccountRef, creatorRef: body.creatorRef, record };
  const observedAt = new Date(record.observedAt);
  return insertObservation(db, {
    source: "client_capture",
    producer: input.producer,
    platform: "onlyfans",
    accountId: page.id,
    kind: CLIENT_ONLYFANS_FEED_OBSERVATION_KIND,
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    // Digests only: a key outlives a fan's erasure, so it names no fan.
    idempotencyKey: `onlyfans_feed:${page.id}:${digest(onlyfansFeedRecordKey(record))}:${onlyfansFeedRecordFingerprint(record)}`,
    observedAt: Number.isNaN(observedAt.getTime()) ? null : observedAt,
    actorPrincipalId: input.userId,
  });
}

export async function applyClientOnlyfansFeed(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; body: ClientOnlyfansFeedBody },
): Promise<ClientOnlyfansFeedResponse> {
  // A cookie session → 403: the route is a client's, not the dashboard's.
  requireApiKeyUser(principal);
  const page = await requireClientFeatureOnLabel(app, request, principal, input.pageLabel, "ofFeed");
  if (page.platform !== "onlyfans") throw new ClientFeatureDisabledError(ONLYFANS_FEED_FEATURE, "platform_unsupported");
  await requireBoundAccount(app, page, input.body);

  const clientVersion = clientVersionOf(request.headers["x-client-version"]);
  const producer = principal.clientProfile === undefined
    ? ingestProducerForClientVersion(clientVersion ?? "unknown")
    : clientTokenIngestProducer(principal.clientProfile, clientVersion);
  const now = new Date();
  const writer = (await getPageTransactionsWriterInfo(app.db, page.id))?.transactionsWriter ?? null;
  const counts = { taken: 0, duplicates: 0, held: 0, outOfRange: 0 };
  const userId = principal.user.id;

  for (const record of input.body.records) {
    const inRange = onlyfansFeedObservedInRange(new Date(record.observedAt), now);
    const money = MONEY_KINDS.has(record.kind);
    if (money && writer === "chatspace" && inRange) {
      // Money commits with its journal entry and the rollups, under the page's one money lock.
      const outcome = await withOfapiSpendTransactionPageLock(app.db, page.id, async (db) => {
        const journaled = await journal(db, { producer, page, body: input.body, record, userId });
        if (!journaled.inserted) return "duplicate" as const;
        await assertPageTransactionsWriter(app, { platformAccountId: page.id, attemptedWriter: "chatspace" });
        await writeRecord(db, page, input.body.creatorRef, record, journaled.receivedAt);
        const fanRef = fanRefOf(record);
        const fanId = fanRef === null ? null : await fanRowId(db, page.id, fanRef, null);
        const sighting = onlyfansFeedSighting(record, journaled.observationId, fanId);
        if (sighting !== null) {
          const applied = await applyFeedMoneySighting(db, page.id, sighting);
          if (applied.status !== "known") {
            const from = applied.reactivatedFrom !== null && applied.reactivatedFrom < sighting.occurredAt ? applied.reactivatedFrom : sighting.occurredAt;
            await rebuildSpenderProjections(db, page.id, from);
            await rebuildRevenueRollups(db, page.id, from);
          }
        }
        return "taken" as const;
      });
      counts[outcome === "duplicate" ? "duplicates" : "taken"] += 1;
      continue;
    }
    const outcome = await app.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const journaled = await journal(db, { producer, page, body: input.body, record, userId });
      if (!journaled.inserted) return "duplicates" as const;
      if (!inRange) return "outOfRange" as const;
      await writeRecord(db, page, input.body.creatorRef, record, journaled.receivedAt);
      return money ? ("held" as const) : ("taken" as const);
    });
    counts[outcome] += 1;
  }

  if (counts.held > 0 || counts.outOfRange > 0) {
    // One line per report, counts only: never a text, an amount or a fan.
    app.logger?.info(
      { pageId: page.id, userId, records: input.body.records.length, ...counts, writer },
      "OnlyFans feed: records journaled only (money held for its writer, or observed out of range)",
    );
  }
  return { pageLabel: page.label, ...counts, serverNow: now.toISOString() };
}

/** How many journaled money records the cutoff applies per transaction. */
const TAKE_MONEY_PAGE = 100;

export interface TakeOnlyfansFeedMoneyResult {
  pageLabel: string;
  previousWriter: string | null;
  /** The money records journaled since `since`, applied oldest first. */
  records: number;
  written: number;
  claimed: number;
  known: number;
}

/**
 * The cutoff of one OnlyFans page: its transactions writer moves to `chatspace`
 * and every purchase, tip and ledger row the feed journaled for it since
 * `since` — `held` while OFAPI still wrote — is applied, oldest first, through
 * the same sighting rule, so what OFAPI already counted is claimed, never
 * counted twice. Idempotent: run again, it finds every sighting known.
 * `dryRun` changes nothing and only counts the records.
 */
export async function takeOnlyfansFeedMoney(
  app: AppContext,
  input: { pageLabel: string; since: Date; dryRun: boolean },
): Promise<TakeOnlyfansFeedMoneyResult> {
  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page || page.platform !== "onlyfans") throw new Error(`No OnlyFans page "${input.pageLabel}"`);
  const writerBefore = (await getPageTransactionsWriterInfo(app.db, page.id))?.transactionsWriter ?? null;
  const result: TakeOnlyfansFeedMoneyResult = { pageLabel: page.label, previousWriter: writerBefore, records: 0, written: 0, claimed: 0, known: 0 };
  if (!input.dryRun) {
    const moved = await setOnlyfansFeedTransactionsWriter(app.db, page.id);
    if (moved === null) throw new Error(`Page "${page.label}" is not an OnlyFans page`);
    result.previousWriter = moved.previousWriter;
  }

  let after: { receivedAt: Date; id: number } | null = null;
  for (;;) {
    const rows = await listOnlyfansFeedMoneyObservations(app.db, { pageId: page.id, since: input.since, after, limit: TAKE_MONEY_PAGE });
    if (rows.length === 0) break;
    after = { receivedAt: rows.at(-1)!.receivedAt, id: rows.at(-1)!.id };
    result.records += rows.length;
    if (input.dryRun) continue;
    await withOfapiSpendTransactionPageLock(app.db, page.id, async (db) => {
      await assertPageTransactionsWriter(app, { platformAccountId: page.id, attemptedWriter: "chatspace" });
      let dirtyFrom = null as Date | null;
      for (const row of rows) {
        const parsed = clientOnlyfansFeedRecordSchema.safeParse((row.payload as { record?: unknown } | null)?.record);
        if (!parsed.success) continue;
        const record = parsed.data;
        if (!onlyfansFeedObservedInRange(new Date(record.observedAt), row.receivedAt)) continue;
        const fanRef = fanRefOf(record);
        const fanId = fanRef === null ? null : await fanRowId(db, page.id, fanRef, null);
        const sighting = onlyfansFeedSighting(record, row.id, fanId);
        if (sighting === null) continue;
        const applied = await applyFeedMoneySighting(db, page.id, sighting);
        result[applied.status] += 1;
        if (applied.status === "known") continue;
        const from = applied.reactivatedFrom !== null && applied.reactivatedFrom < sighting.occurredAt ? applied.reactivatedFrom : sighting.occurredAt;
        dirtyFrom = dirtyFrom === null || from < dirtyFrom ? from : dirtyFrom;
      }
      if (dirtyFrom !== null) {
        await rebuildSpenderProjections(db, page.id, dirtyFrom);
        await rebuildRevenueRollups(db, page.id, dirtyFrom);
      }
    });
  }
  return result;
}
