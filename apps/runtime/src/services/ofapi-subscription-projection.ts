// Live subscription projection (Phase 3 of docs/ofapi-parity-plan.md, D8):
// post-settle projection of subscriptions.new / subscriptions.renewed journal
// rows into page_subscriptions / page_fans for OFAPI-mapped OnlyFans pages,
// keeping the subscriber set fresh between audience sweeps. Same invariants as
// the DM projection (decision #49 D1): never blocks or fails the settle/fanout
// path, idempotent, bookkeeping on the journal row, sweep retries failures.
// The webhook payload carries no renew/expiry dates — those stay whatever the
// sweep last wrote and only ever advance forward.

import {
  findHistoricalPageByOfapiAccountId,
  findPageSubscription,
  listOfapiWebhookEventsForDmProjection,
  markOfapiWebhookEventProjection,
  refreshPageSubscriberCount,
  upsertFanPageExternalPresences,
  upsertFanPages,
  upsertFans,
  upsertPageSubscription,
} from "@agency_hub_core/db";
import {
  dollarsToMills,
  OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { isOfapiAudienceSyncEnabled } from "./sync/ofapi-audience-sync.ts";
import {
  asRecord,
  idToString,
  ofapiWebhookEnvelopeSchema,
} from "./ofapi-payloads.ts";

export const OFAPI_SUBSCRIPTION_PROJECTION_EVENT_TYPES = [
  "subscriptions.new",
  "subscriptions.renewed",
] as const;

export const OFAPI_SUBSCRIPTION_PROJECTION_MAX_ATTEMPTS = 5;
const OFAPI_SUBSCRIPTION_PROJECTION_SWEEP_LIMIT = 200;

export function isOfapiSubscriptionProjectionEventType(eventType: string) {
  return (OFAPI_SUBSCRIPTION_PROJECTION_EVENT_TYPES as readonly string[]).includes(eventType);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// replacePairs["{PRICE}"] arrives as a formatted string like "$4.00".
function parseDollarString(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^\$(\d+(?:\.\d{1,2})?)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface OfapiSubscriptionEventData {
  fanId: string;
  username: string | null;
  displayName: string | null;
  occurredAt: Date | null;
  priceDollars: number | null;
  lastSeenAt: Date | null;
}

/**
 * Maps a subscriptions.* payload; returns null when the subscriber identity is
 * missing. The subscriber is payload.user (full OF user object) — payload's
 * top-level user_id is NOT trusted (in other notification payloads it carries
 * the creator's id).
 */
export function parseOfapiSubscriptionPayload(
  payload: Record<string, unknown>,
): OfapiSubscriptionEventData | null {
  const user = asRecord(payload.user);
  const fanId = idToString(user?.id);
  if (!user || !fanId) {
    return null;
  }

  const replacePairs = asRecord(payload.replacePairs);
  const subscribePrice = user.subscribePrice;

  return {
    fanId,
    username: nonEmpty(user.username),
    displayName: nonEmpty(user.name) ?? nonEmpty(user.displayName),
    occurredAt: parseTimestamp(payload.createdAt),
    priceDollars: parseDollarString(replacePairs?.["{PRICE}"]) ??
      (typeof subscribePrice === "number" && Number.isFinite(subscribePrice) && subscribePrice > 0
        ? subscribePrice
        : null),
    lastSeenAt: parseTimestamp(user.lastSeen),
  };
}

type OfapiSubscriptionProjectionOutcome =
  | { status: "projected" }
  | { status: "skipped"; reason: string };

interface OfapiSubscriptionProjectableRow {
  id: number;
  eventType: string;
  ofapiAccountId: string | null;
  payload: Record<string, unknown>;
  projectionStatus: string;
  receivedAt: Date;
}

async function projectOfapiSubscriptionEvent(
  app: AppContext,
  row: OfapiSubscriptionProjectableRow,
): Promise<OfapiSubscriptionProjectionOutcome> {
  if (!isOfapiSubscriptionProjectionEventType(row.eventType)) {
    return { status: "skipped", reason: `Event type "${row.eventType}" is not projected` };
  }

  const envelope = ofapiWebhookEnvelopeSchema.safeParse(row.payload);
  if (!envelope.success) {
    return { status: "skipped", reason: "Journaled payload is not a valid OFAPI envelope" };
  }

  const page = row.ofapiAccountId
    ? await findHistoricalPageByOfapiAccountId(app.db, row.ofapiAccountId)
    : null;
  if (!page) {
    return {
      status: "skipped",
      reason: row.ofapiAccountId
        ? `No page mapped to OFAPI account "${row.ofapiAccountId}"`
        : "Envelope has no account_id",
    };
  }
  if (page.platform !== "onlyfans") {
    return { status: "skipped", reason: "Mapped page is not an OnlyFans page" };
  }

  const payload = asRecord(envelope.data.payload) ?? {};
  const parsed = parseOfapiSubscriptionPayload(payload);
  if (!parsed) {
    return { status: "skipped", reason: "Subscription payload is missing the subscriber identity" };
  }

  const occurredAt = parsed.occurredAt ?? row.receivedAt;

  await app.db.transaction(async (tx) => {
    const [fan] = await upsertFans(tx, [{
      platform: "onlyfans" as const,
      platformUserId: parsed.fanId,
      ...(parsed.username !== null ? { username: parsed.username } : {}),
      ...(parsed.displayName !== null ? { displayName: parsed.displayName } : {}),
    }]);
    if (!fan) {
      throw new Error("Fan upsert returned no row");
    }

    // P-26: lock the row for the whole read-carry-forward-upsert cycle. The
    // audience sweep owns renew/expiry dates and the generation stamp; without
    // the lock a sweep landing between this read and the full-row upsert below
    // would get its fresher dates clobbered back to this stale snapshot (the
    // same lost-update shape as B11). Lock order — fans before subscriptions —
    // matches the sweep's applyActiveFans.
    const existing = await findPageSubscription(tx, {
      platformAccountId: page.id,
      platformSubscriptionId: parsed.fanId,
      forUpdate: true,
    });

    const priceMills = parsed.priceDollars !== null
      ? dollarsToMills(parsed.priceDollars)
      : existing?.priceMills ?? 0n;
    const sourceCreatedAt = existing?.sourceCreatedAt ?? occurredAt;
    // Forward-only: an out-of-order older event never regresses the timestamp.
    const sourceUpdatedAt = existing?.sourceUpdatedAt && existing.sourceUpdatedAt > occurredAt
      ? existing.sourceUpdatedAt
      : occurredAt;

    await upsertPageSubscription(tx, {
      platformSubscriptionId: parsed.fanId,
      platformAccountId: page.id,
      fanId: fan.id,
      rawStatus: existing?.rawStatus ?? 0,
      canonicalStatus: "active",
      priceMills,
      renewPriceMills: existing?.renewPriceMills ?? priceMills,
      autoRenew: existing?.autoRenew ?? null,
      billingCycleDays: existing?.billingCycleDays ?? null,
      durationDays: existing?.durationDays ?? null,
      // The webhook has no dates; the audience sweep owns renew/expiry.
      renewDate: existing?.renewDate ?? null,
      sourceCreatedAt,
      sourceUpdatedAt,
      endsAt: existing?.endsAt ?? null,
      lastSeenGeneration: existing?.lastSeenGeneration ?? null,
    });

    await upsertFanPages(tx, [{
      fanId: fan.id,
      platformAccountId: page.id,
      isSubscriber: true,
      subscriberSince: sourceCreatedAt,
      subscriptionExpiresAt: existing?.endsAt ?? null,
      autoRenew: existing?.autoRenew ?? null,
    }]);
    await refreshPageSubscriberCount(tx, page.id);

    if (parsed.lastSeenAt) {
      await upsertFanPageExternalPresences(tx, [{
        fanId: fan.id,
        platformAccountId: page.id,
        externalPresenceAt: parsed.lastSeenAt,
        externalPresenceObservedAt: row.receivedAt,
        externalPresenceSource: OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN,
      }]);
    }
  });

  return { status: "projected" };
}

/**
 * Post-settle hook (same contract as the DM projection): flag-gated, never
 * throws into the event processor, outcomes recorded on the journal row.
 */
export async function runOfapiSubscriptionProjectionForSettledRow(
  app: AppContext,
  row: OfapiSubscriptionProjectableRow,
) {
  if (
    !isOfapiAudienceSyncEnabled(app.config) ||
    !isOfapiSubscriptionProjectionEventType(row.eventType)
  ) {
    return;
  }
  if (row.projectionStatus !== "pending" && row.projectionStatus !== "failed") {
    return;
  }

  try {
    const outcome = await projectOfapiSubscriptionEvent(app, row);
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id,
      status: outcome.status,
      error: outcome.status === "skipped" ? outcome.reason : null,
    });
  } catch (error) {
    app.logger.warn(
      { err: error, eventId: row.id, eventType: row.eventType },
      "OFAPI subscription projection failed; the sweep will retry",
    );
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
}

/** Minutely sweep: re-projects pending/failed subscription rows (cap 5 attempts). */
export async function sweepOfapiSubscriptionProjections(app: AppContext) {
  if (!isOfapiAudienceSyncEnabled(app.config)) {
    return 0;
  }

  const rows = await listOfapiWebhookEventsForDmProjection(app.db, {
    eventTypes: OFAPI_SUBSCRIPTION_PROJECTION_EVENT_TYPES,
    maxAttempts: OFAPI_SUBSCRIPTION_PROJECTION_MAX_ATTEMPTS,
    limit: OFAPI_SUBSCRIPTION_PROJECTION_SWEEP_LIMIT,
  });

  for (const row of rows) {
    await runOfapiSubscriptionProjectionForSettledRow(app, row);
  }

  return rows.length;
}
