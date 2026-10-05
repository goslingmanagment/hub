import {
  CLIENT_AUDIENCE_NEW_MAX_WINDOW_HOURS,
  type ClientAudienceNewCoverageReason,
  type ClientAudienceNewItem,
  type ClientAudienceNewKind,
  type ClientAudienceNewQuery,
  type ClientAudienceNewRefusalReason,
  type ClientAudienceNewResponse,
  type ClientAudienceNewStatusSource,
  type ClientAudienceNewSubscribedAtSource,
  type ClientAudienceNewSubscriptionStatus,
  type ClientCoverageLevel,
} from "@agency_hub_core/contracts";
import {
  classifyClientAudienceNewEvent,
  countClientAudienceNewUnlisted,
  countClientAudiencePendingNotifications,
  countClientAudienceProjectionBacklog,
  findPageSummaryByLabel,
  getWebhookDeliveryHistoryCoverage,
  listCheckpointStates,
  listClientAudienceNewEvents,
  readClientAudienceClock,
  readClientAudienceNewFans,
  readClientFanClaimSummaries,
  type ClientAudienceNewClass,
  type ClientAudienceNewFan,
  type ClientAudienceNewSubscription,
  type ClientAudienceNewThread,
  type ClientAudienceNewWindow,
  type Database,
} from "@agency_hub_core/db";
import { z } from "zod";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { OFAPI_WEBHOOK_CANONICALIZER_VERSION } from "./canonicalize/ofapi-webhook.ts";
import { requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import { BadRequestError, ClientFeatureDisabledError } from "./errors.ts";
import { OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS } from "./ofapi-delivery-history-signal.ts";
import { OFAPI_SUBSCRIPTION_PROJECTION_EVENT_TYPES } from "./ofapi-subscription-projection.ts";
import { readLatestOfapiWelcomeTemplate } from "./ofapi-welcome-template.ts";
import {
  decodeSignedCursor,
  encodeSignedCursor,
  signedCursorKeyRing,
  SignedCursorInvalidError,
  type SignedCursorScope,
  type SignedCursorSpec,
} from "./signed-cursor.ts";
import { parseOfapiAudienceCursorState } from "./sync/cursor-state.ts";

/**
 * chat-extension H-7c: the "new subscribers" list of one OnlyFans page
 * (`clientAudienceNew`).
 *
 * Database only. The rows are the subscription events the hub already
 * collected (OFAPI webhooks, canonicalized into `domain_events`); beside each
 * fan the route reads what the hub holds right now: the subscription, the chat,
 * the greeting. It asks no platform, queues no work and writes nothing. A
 * request reads everything in one read-only snapshot of the database.
 *
 * A WALK is fixed at its first page: the window's two ends and the moment the
 * hub's records are cut at travel in the signed cursor, so a subscription that
 * arrives while a client pages through the list never shifts a row between
 * pages. The cursor is bound to the page and the person; `windowHours` travels
 * inside it, so a cursor of the caller's own walk presented with another
 * window is told apart (`cursor_window_mismatch`) from one that is not the
 * caller's at all (`cursor_invalid`).
 */

const NEWCOMERS_FLAG = "newcomers";

/** A new state shape is a new domain: an old cursor then fails its signature instead of being misread. */
export const CLIENT_AUDIENCE_NEW_CURSOR_DOMAIN = "agency-hub:client-audience-new-cursor:v1";
/**
 * How long a walk may go on. The rows of a walk are fixed, but what is said
 * about each fan is read per page, so a walk is not kept for days: an hour is
 * longer than any pass through the list, and after it the client reads the
 * first page again.
 */
export const CLIENT_AUDIENCE_NEW_CURSOR_TTL_MS = 60 * 60_000;
/**
 * How far a stored subscription start may lie from a notification's time and
 * still be the same subscription. OnlyFans stamps the notification to the
 * minute and the subscription to the second, so the two differ by up to a
 * minute. A start older than the notification by more than this belongs to an
 * earlier subscription of the fan: it is never the row's date, and it makes
 * the row a return.
 */
export const CLIENT_AUDIENCE_SUBSCRIBE_AT_TOLERANCE_MS = 5 * 60_000;
/**
 * The webhook kinds the list's rows are canonicalized from (`subscriptions.new`
 * → `subscription.started`, `subscriptions.renewed` → `subscription.renewed`).
 * One of them journaled and not canonicalized yet is a row the list lacks.
 */
export const CLIENT_AUDIENCE_NOTIFICATION_KINDS = ["subscriptions.new", "subscriptions.renewed"] as const;

const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const HOUR_MS = 60 * 60_000;

const epochMs = z.number().int().nonnegative();

/** What a cursor carries. Strict at every depth: the decoder accepts only the bytes that were signed. */
const audienceCursorStateSchema = z.object({
  /** The walk's `windowHours`. */
  hours: z.number().int().min(1).max(CLIENT_AUDIENCE_NEW_MAX_WINDOW_HOURS),
  /** `window.to` and `window.snapshotAt`, epoch milliseconds. */
  to: epochMs,
  snapshotAt: epochMs,
  /** The last row served: the next page holds the rows strictly after it. */
  before: z.object({
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    id: z.string().regex(/^[1-9]\d{0,18}$/),
  }).strict(),
}).strict();

type AudienceCursorState = z.infer<typeof audienceCursorStateSchema>;

const AUDIENCE_CURSOR_SPEC: SignedCursorSpec<AudienceCursorState> = {
  domain: CLIENT_AUDIENCE_NEW_CURSOR_DOMAIN,
  state: audienceCursorStateSchema,
  ttlMs: CLIENT_AUDIENCE_NEW_CURSOR_TTL_MS,
};

function refuseCursor(reason: ClientAudienceNewRefusalReason): never {
  throw new BadRequestError(
    reason === "cursor_window_mismatch"
      ? "cursor belongs to a walk with another windowHours"
      : "cursor is not valid for this request",
    { reason },
  );
}

/**
 * A stored instant as the wire carries it; null for one the client's frozen
 * pattern cannot read (it takes a four-digit year).
 */
function wireInstant(value: Date | null): string | null {
  if (value === null || Number.isNaN(value.getTime())) {
    return null;
  }
  const year = value.getUTCFullYear();
  return year >= 0 && year <= 9999 ? value.toISOString() : null;
}

/** The subscriber sweep of a page as its checkpoint records it. */
export interface AudienceSweepState {
  /** The newest sweep: the one in flight, else the last completed. */
  generation: number;
  inFlight: boolean;
  lastCompletedAt: Date | null;
  /** The last sweep ended without a result the hub trusts (the empty-sweep guard). */
  unverified: boolean;
}

/** The page's subscriber-sweep checkpoint; null for a page that has none (never swept, or not an OFAPI page). */
export function audienceSweepState(checkpointState: unknown): AudienceSweepState | null {
  const state = parseOfapiAudienceCursorState(checkpointState);
  if (state === null) {
    return null;
  }
  const completed = state.lastSweepCompletedAt === null ? Number.NaN : Date.parse(state.lastSweepCompletedAt);
  return {
    generation: state.generation,
    inFlight: state.sweepStartedAt !== null,
    lastCompletedAt: Number.isNaN(completed) ? null : new Date(completed),
    unverified: state.lastSweepUnverifiedAt !== null,
  };
}

/**
 * The row's kind. OnlyFans' own word decides it, with one correction: what it
 * calls a new subscriber is a return when the hub holds a subscription of the
 * fan that started before this notification, by more than the tolerance. A fan
 * who comes back through a free-trial link is announced as
 * `new_subscriber_trial`; on production 5 of 65 trial notifications of a month
 * were fans whose subscription a sweep had read as 5 to 10 months old.
 *
 * Whoever wrote the stored start, it is evidence of an earlier subscription: a
 * sweep writes OnlyFans' own `subscribeAt`, and a notification writes its own
 * time once, when it creates the row, so a later notification that finds an
 * older start found an earlier one's row. `trial` stays as OnlyFans said it.
 *
 * The chat is not asked. The read holds only the time of the fan's LAST
 * message, and a kind decided by it would flip back to `new` the moment a
 * returning fan writes again.
 */
export function audienceKind(
  listed: ClientAudienceNewClass,
  occurredAt: Date,
  subscription: Pick<ClientAudienceNewSubscription, "sourceCreatedAt"> | null,
): { kind: ClientAudienceNewKind; trial: boolean } {
  const start = subscription?.sourceCreatedAt ?? null;
  const subscribedBefore = start !== null
    && occurredAt.getTime() - start.getTime() > CLIENT_AUDIENCE_SUBSCRIBE_AT_TOLERANCE_MS;
  return { kind: listed.kind === "new" && subscribedBefore ? "returning" : listed.kind, trial: listed.trial };
}

/**
 * When the fan subscribed. The notification's time, unless a subscriber sweep
 * has read the subscription's own start and that start names the same
 * subscription as the notification: within the tolerance of it. The stored
 * start of a fan who came back is the start of an earlier subscription until a
 * sweep reads the new one, and never passes this check.
 */
export function audienceSubscribedAt(
  occurredAt: Date,
  subscription: Pick<ClientAudienceNewSubscription, "lastSeenGeneration" | "sourceCreatedAt"> | null,
): { at: Date; source: ClientAudienceNewSubscribedAtSource } {
  const start = subscription?.sourceCreatedAt ?? null;
  // Only a sweep sets the generation, and a notification never replaces a start a sweep wrote.
  const swept = subscription !== null && subscription.lastSeenGeneration !== null;
  if (swept && start !== null
    && Math.abs(start.getTime() - occurredAt.getTime()) <= CLIENT_AUDIENCE_SUBSCRIBE_AT_TOLERANCE_MS) {
    return { at: start, source: "subscribeAt" };
  }
  return { at: occurredAt, source: "notification" };
}

/**
 * Which collector the subscription's state rests on.
 * - Not current: a `subscriptions.expired` notification marks the row expired;
 *   a sweep's end only retires a row it no longer found and leaves its status.
 * - Current: the newest sweep saw the fan (the row carries its generation, or
 *   the one before while a sweep is still walking), else a notification
 *   (re)activated it after that sweep and nothing has confirmed it since.
 */
export function audienceStatusSource(
  subscription: Pick<ClientAudienceNewSubscription, "isCurrent" | "canonicalStatus" | "lastSeenGeneration"> | null,
  sweep: Pick<AudienceSweepState, "generation" | "inFlight"> | null,
): ClientAudienceNewStatusSource {
  if (subscription === null) {
    return "none";
  }
  if (!subscription.isCurrent) {
    return subscription.canonicalStatus === "expired" ? "webhook" : "sweep";
  }
  if (subscription.lastSeenGeneration === null || sweep === null) {
    return "webhook";
  }
  const newestWhole = sweep.inFlight ? sweep.generation - 1 : sweep.generation;
  return subscription.lastSeenGeneration >= newestWhole ? "sweep" : "webhook";
}

function subscriptionStatus(subscription: ClientAudienceNewSubscription | null): ClientAudienceNewSubscriptionStatus {
  if (subscription === null) {
    return "unknown";
  }
  if (!subscription.isCurrent) {
    return "expired";
  }
  return subscription.canonicalStatus === "active" ? "active" : "unknown";
}

/**
 * When the subscription ends. A notification carries no end, so a fan who came
 * back keeps the end of the period before until a sweep reads the new one: on
 * a current subscription an end that is not after the row's last lifecycle
 * evidence (the notification that reactivated it) is that old end, and the
 * answer is "not known". A subscription that is over keeps its end: there the
 * end IS the last evidence.
 */
export function audienceEndsAt(
  subscription: Pick<ClientAudienceNewSubscription, "isCurrent" | "endsAt" | "lastEvidenceAt"> | null,
): Date | null {
  if (subscription === null || subscription.endsAt === null) {
    return null;
  }
  const { endsAt, lastEvidenceAt } = subscription;
  const stale = subscription.isCurrent && lastEvidenceAt !== null && endsAt.getTime() <= lastEvidenceAt.getTime();
  return stale ? null : endsAt;
}

/**
 * The fan's subscription as the hub holds it now. `isSubscriber` and
 * `subscriptionStatus` come from two projections (the page's fan record and
 * the subscription row), so a client can require that they agree. Without a
 * subscription row the hub knows nothing either way: `isSubscriber` is null
 * even if a fan record exists, because that record's default is "not a
 * subscriber".
 */
export function audienceStatus(
  fan: Pick<ClientAudienceNewFan, "isSubscriber" | "subscription">,
  sweep: Pick<AudienceSweepState, "generation" | "inFlight"> | null,
): ClientAudienceNewItem["status"] {
  const { subscription } = fan;
  return {
    isSubscriber: subscription === null ? null : fan.isSubscriber,
    subscriptionStatus: subscriptionStatus(subscription),
    endsAt: wireInstant(audienceEndsAt(subscription)),
    asOf: wireInstant(subscription?.lastSeenAt ?? null),
    source: audienceStatusSource(subscription, sweep),
  };
}

/** `page_dm_threads.message_coverage_status` in the words of every client read. */
const THREAD_COVERAGE: ReadonlyMap<string, ClientCoverageLevel> = new Map([
  ["complete", "complete"],
  // A window of the history was read, not all of it.
  ["partial_window", "partial"],
  // The history was never read: the hub holds only what arrived by notification.
  ["pending_backfill", "unknown"],
]);

export function audienceThread(thread: ClientAudienceNewThread | null): ClientAudienceNewItem["thread"] {
  if (thread === null) {
    return null;
  }
  return {
    lastMessageAt: wireInstant(thread.lastMessageAt),
    lastFanMessageAt: wireInstant(thread.lastFanMessageAt),
    lastModelMessageAt: wireInstant(thread.lastModelMessageAt),
    storedMessageCount: Math.max(0, thread.storedMessageCount),
    coverage: THREAD_COVERAGE.get(thread.messageCoverageStatus) ?? "unknown",
    backfillComplete: thread.messageBackfillComplete,
  };
}

const COVERAGE_ORDER: readonly ClientCoverageLevel[] = ["complete", "partial", "unknown"];

/**
 * Whether the hub can vouch for the window's list, and why not.
 *
 * Four things could leave the list short or a row's `status` stale, and each
 * has a witness:
 * - a notification that never reached the hub: the provider's webhook delivery
 *   history, which the hub collects and checks a few minutes behind real time.
 *   Without it nothing is known (`unknown`); checked only up to a moment well
 *   before the window's end, the tail is unchecked (`partial`);
 * - a notification that arrived and is not an event yet: journaled, waiting
 *   for the canonicalizer. The list reads events, so that row is missing;
 * - a notification that arrived and is not applied to the subscriber state;
 * - a subscriber state that only notifications ever wrote: no completed sweep.
 */
export function evaluateAudienceCoverage(input: {
  from: Date;
  to: Date;
  /** Null: the delivery history is not collected. `frontier` null: no window of it is complete yet. */
  delivery: { frontier: Date | null } | null;
  /** Subscription notifications of the window journaled and not canonicalized yet. */
  pendingNotifications: number;
  backlog: { pending: number; failed: number };
  sweep: Pick<AudienceSweepState, "lastCompletedAt" | "unverified"> | null;
}): { state: ClientCoverageLevel; reasons: ClientAudienceNewCoverageReason[] } {
  const found: Array<[ClientAudienceNewCoverageReason, ClientCoverageLevel]> = [];
  const frontier = input.delivery?.frontier ?? null;
  if (input.delivery === null) {
    found.push(["delivery_history_off", "unknown"]);
  } else if (frontier === null) {
    found.push(["delivery_history_pending", "unknown"]);
  } else if (frontier.getTime() < input.from.getTime()) {
    found.push(["delivery_history_before_window", "unknown"]);
  } else if (frontier.getTime() < input.to.getTime() - OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS) {
    // Beyond the collector's own "stuck" threshold: its normal lag is not a hole.
    found.push(["delivery_history_behind", "partial"]);
  }
  if (input.pendingNotifications > 0) {
    found.push(["subscription_event_pending", "partial"]);
  }
  if (input.backlog.pending > 0) {
    found.push(["subscription_projection_pending", "partial"]);
  }
  if (input.backlog.failed > 0) {
    found.push(["subscription_projection_failed", "partial"]);
  }
  if (input.sweep === null || input.sweep.lastCompletedAt === null) {
    found.push(["audience_sweep_missing", "partial"]);
  } else if (input.sweep.unverified) {
    found.push(["audience_sweep_unverified", "partial"]);
  }
  const worst = Math.max(0, ...found.map(([, level]) => COVERAGE_ORDER.indexOf(level)));
  return { state: COVERAGE_ORDER[worst]!, reasons: found.map(([reason]) => reason) };
}

interface AudienceWalk {
  hours: number;
  window: ClientAudienceNewWindow;
  before: AudienceCursorState["before"] | null;
}

/** The walk a request continues, or the one it starts at `now`. */
function resolveWalk(input: {
  pageId: number;
  query: ClientAudienceNewQuery;
  scope: SignedCursorScope;
  now: Date;
  ring: ReturnType<typeof signedCursorKeyRing>;
}): AudienceWalk {
  const { pageId, query, now } = input;
  if (query.cursor === undefined) {
    return {
      hours: query.windowHours,
      window: { pageId, from: new Date(now.getTime() - query.windowHours * HOUR_MS), to: now, snapshotAt: now },
      before: null,
    };
  }
  let state: AudienceCursorState;
  try {
    state = decodeSignedCursor(AUDIENCE_CURSOR_SPEC, query.cursor, { scope: input.scope, now }, input.ring);
  } catch (error) {
    if (error instanceof SignedCursorInvalidError) {
      refuseCursor("cursor_invalid");
    }
    throw error;
  }
  // The cursor is the caller's own (it passed its signature for this page and
  // person), so saying that its window is another one reveals nothing.
  if (state.hours !== query.windowHours) {
    refuseCursor("cursor_window_mismatch");
  }
  const to = new Date(state.to);
  return {
    hours: state.hours,
    window: { pageId, from: new Date(to.getTime() - state.hours * HOUR_MS), to, snapshotAt: new Date(state.snapshotAt) },
    before: state.before,
  };
}

export async function getClientAudienceNew(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; query: ClientAudienceNewQuery },
): Promise<ClientAudienceNewResponse> {
  // A cookie session → 403: the route is a client's, not the dashboard's.
  requireApiKeyUser(principal);
  const stored = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!stored) {
    // A missing page answers like one not granted: the refusal reveals nothing.
    throw new ClientFeatureDisabledError(NEWCOMERS_FLAG, "not_granted");
  }
  // The hub's own check, before anything is read: the page is granted to the
  // caller, the feature exists on its platform, the owner's `newcomers` switch
  // is on for it, and the extension is not outdated.
  const page = await requireClientFeature(app, request, principal, { id: stored.id }, NEWCOMERS_FLAG);

  const ring = signedCursorKeyRing(app.config);
  const scope: SignedCursorScope = { pageId: page.id, userId: principal.user.id };
  const { query } = input;

  return app.db.transaction(async (transaction): Promise<ClientAudienceNewResponse> => {
    const tx = transaction as unknown as Database;
    const now = await readClientAudienceClock(tx);
    const walk = resolveWalk({ pageId: page.id, query, scope, now, ring });
    const { window } = walk;

    const events = await listClientAudienceNewEvents(tx, { ...window, before: walk.before, limit: query.limit });
    const fanRefs = events.rows.map((row) => row.fanRef);
    const fans = await readClientAudienceNewFans(tx, { pageId: page.id, fanRefs });
    const claims = await readClientFanClaimSummaries(tx, { pageId: page.id, fanRefs, userId: principal.user.id });

    const unknownCount = await countClientAudienceNewUnlisted(tx, window);
    const delivery = await getWebhookDeliveryHistoryCoverage(tx);
    const pendingNotifications = await countClientAudiencePendingNotifications(tx, {
      pageId: page.id,
      since: window.from,
      kinds: CLIENT_AUDIENCE_NOTIFICATION_KINDS,
      belowParseVersion: OFAPI_WEBHOOK_CANONICALIZER_VERSION,
    });
    const backlog = await countClientAudienceProjectionBacklog(tx, {
      pageId: page.id,
      since: window.from,
      eventTypes: OFAPI_SUBSCRIPTION_PROJECTION_EVENT_TYPES,
    });
    const [checkpoint] = await listCheckpointStates(tx, [page.id], "subscribers");
    const sweep = audienceSweepState(checkpoint?.state);
    const coverage = evaluateAudienceCoverage({
      from: window.from, to: window.to, delivery, pendingNotifications, backlog, sweep,
    });
    const welcomeTemplate = await readLatestOfapiWelcomeTemplate(tx, page.id);

    const items = events.rows.flatMap((event): ClientAudienceNewItem[] => {
      const listed = classifyClientAudienceNewEvent(event.type, event.subType);
      const fan = fans.get(event.fanRef);
      const claim = claims.get(event.fanRef);
      // The reader lists only classified events and answers every fan it was asked for.
      if (listed === null || fan === undefined || claim === undefined) {
        return [];
      }
      const kind = audienceKind(listed, event.occurredAt, fan.subscription);
      const subscribed = audienceSubscribedAt(event.occurredAt, fan.subscription);
      return [{
        eventRef: event.eventId,
        fanRef: event.fanRef,
        username: fan.username,
        displayName: fan.displayName,
        kind: kind.kind,
        trial: kind.trial,
        subscribedAt: subscribed.at.toISOString(),
        subscribedAtSource: subscribed.source,
        status: audienceStatus(fan, sweep),
        thread: audienceThread(fan.thread),
        claim,
      }];
    });

    const last = events.rows.at(-1);
    return {
      pageLabel: page.label,
      window: {
        hours: walk.hours,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        snapshotAt: window.snapshotAt.toISOString(),
      },
      serverNow: now.toISOString(),
      coverage: {
        state: coverage.state,
        deliveryFrontier: wireInstant(delivery?.frontier ?? null),
        lastAudienceSweepAt: wireInstant(sweep?.lastCompletedAt ?? null),
        reasons: coverage.reasons,
      },
      unknownCount,
      welcomeTemplate,
      items,
      nextCursor: events.hasMore && last !== undefined
        ? encodeSignedCursor(AUDIENCE_CURSOR_SPEC, {
          scope,
          state: {
            hours: walk.hours,
            to: window.to.getTime(),
            snapshotAt: window.snapshotAt.getTime(),
            before: last.position,
          },
          now,
        }, ring)
        : null,
    };
  }, READ_SNAPSHOT);
}
