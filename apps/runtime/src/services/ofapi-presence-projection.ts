// Presence projection (Phase 4 of docs/ofapi-parity-plan.md, D9): post-settle
// projection of users.online / users.offline journal rows into the existing
// presence store (page_fans.external_presence_*) for KNOWN fans — unknown fan
// ids are skipped, never looked up over REST. Cost ~0: webhooks are already
// journaled and the store is forward-only, so out-of-order events cannot
// regress a fresher lastSeen. Same invariants as the other projections: never
// blocks or fails the settle/fanout path, idempotent, bookkeeping on the
// journal row, the minutely sweep retries failures.

import {
  findHistoricalPageByOfapiAccountId,
  findPlatformFan,
  listOfapiWebhookEventsForDmProjection,
  markOfapiWebhookEventProjection,
  upsertFanPageExternalPresences,
} from "@agency_hub_core/db";
import { OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  asRecord,
  idToString,
  ofapiWebhookEnvelopeSchema,
} from "./ofapi-payloads.ts";

export const OFAPI_PRESENCE_PROJECTION_EVENT_TYPES = [
  "users.online",
  "users.offline",
] as const;

export const OFAPI_PRESENCE_PROJECTION_MAX_ATTEMPTS = 5;
const OFAPI_PRESENCE_PROJECTION_SWEEP_LIMIT = 200;

export function isOfapiPresenceProjectionEnabled(
  config?: Pick<AppContext["config"], "ofapiPresenceProjectionEnabled">,
) {
  return config?.ofapiPresenceProjectionEnabled === true;
}

export function isOfapiPresenceProjectionEventType(eventType: string) {
  return (OFAPI_PRESENCE_PROJECTION_EVENT_TYPES as readonly string[]).includes(eventType);
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface OfapiPresenceEventData {
  fanId: string;
  // When the fan was last seen online: for users.online this is "now"; for
  // users.offline it is the historical lastSeen (earlier than the status
  // change, per the live captures) — last_seen_online_at carries the right
  // value for both, with status_changed_at/observed_at as fallbacks.
  lastSeenAt: Date | null;
  observedAt: Date | null;
}

export function parseOfapiPresencePayload(
  payload: Record<string, unknown>,
): OfapiPresenceEventData | null {
  const fanId = idToString(asRecord(payload.fan)?.id);
  if (!fanId) {
    return null;
  }

  return {
    fanId,
    lastSeenAt: parseTimestamp(payload.last_seen_online_at) ??
      parseTimestamp(payload.status_changed_at) ??
      parseTimestamp(payload.observed_at),
    observedAt: parseTimestamp(payload.observed_at),
  };
}

type OfapiPresenceProjectionOutcome =
  | { status: "projected" }
  | { status: "skipped"; reason: string };

interface OfapiPresenceProjectableRow {
  id: number;
  eventType: string;
  ofapiAccountId: string | null;
  payload: Record<string, unknown>;
  projectionStatus: string;
  receivedAt: Date;
}

async function projectOfapiPresenceEvent(
  app: AppContext,
  row: OfapiPresenceProjectableRow,
): Promise<OfapiPresenceProjectionOutcome> {
  if (!isOfapiPresenceProjectionEventType(row.eventType)) {
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
  const parsed = parseOfapiPresencePayload(payload);
  if (!parsed) {
    return { status: "skipped", reason: "Presence payload has no fan id" };
  }
  const lastSeenAt = parsed.lastSeenAt ?? row.receivedAt;

  // D9: known fans only — presence events fire for the whole audience, and a
  // REST lookup per unknown id would burn credits for fans core does not track.
  const fan = await findPlatformFan(app.db, "onlyfans", parsed.fanId);
  if (!fan) {
    return { status: "skipped", reason: `Fan "${parsed.fanId}" is not known to core` };
  }

  await upsertFanPageExternalPresences(app.db, [{
    fanId: fan.id,
    platformAccountId: page.id,
    externalPresenceAt: lastSeenAt,
    externalPresenceObservedAt: parsed.observedAt ?? row.receivedAt,
    externalPresenceSource: OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN,
  }]);

  return { status: "projected" };
}

/**
 * Post-settle hook (same contract as the DM projection): flag-gated, never
 * throws into the event processor, outcomes recorded on the journal row.
 */
export async function runOfapiPresenceProjectionForSettledRow(
  app: AppContext,
  row: OfapiPresenceProjectableRow,
) {
  if (
    !isOfapiPresenceProjectionEnabled(app.config) ||
    !isOfapiPresenceProjectionEventType(row.eventType)
  ) {
    return;
  }
  if (row.projectionStatus !== "pending" && row.projectionStatus !== "failed") {
    return;
  }

  try {
    const outcome = await projectOfapiPresenceEvent(app, row);
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id,
      status: outcome.status,
      error: outcome.status === "skipped" ? outcome.reason : null,
    });
  } catch (error) {
    app.logger.warn(
      { err: error, eventId: row.id, eventType: row.eventType },
      "OFAPI presence projection failed; the sweep will retry",
    );
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
}

/** Minutely sweep: re-projects pending/failed presence rows (cap 5 attempts). */
export async function sweepOfapiPresenceProjections(app: AppContext) {
  if (!isOfapiPresenceProjectionEnabled(app.config)) {
    return 0;
  }

  const rows = await listOfapiWebhookEventsForDmProjection(app.db, {
    eventTypes: OFAPI_PRESENCE_PROJECTION_EVENT_TYPES,
    maxAttempts: OFAPI_PRESENCE_PROJECTION_MAX_ATTEMPTS,
    limit: OFAPI_PRESENCE_PROJECTION_SWEEP_LIMIT,
  });

  for (const row of rows) {
    await runOfapiPresenceProjectionForSettledRow(app, row);
  }

  return rows.length;
}
