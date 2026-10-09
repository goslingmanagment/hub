import { sql } from "drizzle-orm";
// OFAPI account health + credit ops (Phase 3 of docs/ofapi-integration-plan.md,
// D9): accounts.* webhook events project into pages.ofapi_auth_status
// (post-settle, never blocking the settle/fanout path), and the minutely OFAPI
// sweep checks the silent failure modes — low credit balance and webhook
// silence — opening/resolving debounced Telegram-backed notification incidents.
// Everything is gated by OFAPI_ACCOUNT_HEALTH_ENABLED (default off).

import {
  advancePageOfapiAuthStatus,
  withOfapiBindingLock,
  lockPageSyncStatesForPage,
  getOfapiBindingPage,
  findPageByOfapiAccountId,
  getLatestOfapiWebhookEventReceivedAt,
  getOfapiCreditState,
  getSyncStreamsForPlatform,
  listOfapiMappedPages,
  pausePageSyncForAuth,
  listOfapiWebhookEventsForDmProjection,
  markOfapiWebhookEventProjection,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { asRecord } from "./ofapi-payloads.ts";
import { OFAPI_ACCOUNT_HEALTH_EVENT_TYPES, ofapiAccountLifecycleTime } from "./ofapi-lifecycle-contract.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import {
  notifyOfapiAuthIncident,
  notifyOfapiGlobalIncident,
  resolveOfapiAuthIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import { runOfapiLinkStatsSeriesMonitor } from "./ofapi-link-stats-monitor.ts";

export const OFAPI_ACCOUNT_EVENT_PREFIX = "accounts.";

// accounts.* event suffixes that mean the operator must act. session_expired is
// deliberately not here: OFAPI fires it after recovering the session silently
// (still authenticated) — it alerts for visibility but is not an action state.
export const OFAPI_AUTH_ACTION_REQUIRED_STATUSES = new Set([
  "authentication_failed",
  "disconnected",
  "account_not_found",
  "otp_code_required",
  "face_otp_required",
]);

const OFAPI_AUTH_ALERT_STATUSES = new Set([
  "session_expired",
  ...OFAPI_AUTH_ACTION_REQUIRED_STATUSES,
]);

const OFAPI_AUTH_RECOVERED_STATUSES = new Set(["connected", "reconnected"]);

const DEFAULT_CREDIT_ALERT_THRESHOLD = 1000;
const DEFAULT_WEBHOOK_SILENCE_THRESHOLD_MINUTES = 720;

export function isOfapiAccountHealthEnabled(
  config?: Pick<AppContext["config"], "ofapiAccountHealthEnabled">,
) {
  return config?.ofapiAccountHealthEnabled === true;
}

export function isOfapiAccountEventType(eventType: string) {
  return (OFAPI_ACCOUNT_HEALTH_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function ofapiAuthStatusNeedsAction(status: string | null | undefined) {
  return typeof status === "string" && OFAPI_AUTH_ACTION_REQUIRED_STATUSES.has(status);
}

interface OfapiAccountEventRow {
  id: number;
  eventType: string;
  ofapiAccountId: string | null;
  receivedAt: Date;
  bindingGeneration?: number;
  payload?: Record<string, unknown>;
  projectionStatus?: string;
}

/**
 * Post-settle projection of one accounts.* journal row: advance the page's
 * auth state (forward-only by provider occurrence) and open/resolve the per-page
 * ofapi_auth incident. Errors escape the transaction so state and effects roll back.
 */
async function applyCurrentOfapiAccountHealthEvent(
  app: AppContext,
  row: OfapiAccountEventRow,
) {
  if (!isOfapiAccountHealthEnabled(app.config) || !isOfapiAccountEventType(row.eventType)) {
    return;
  }

  const page = row.ofapiAccountId
    ? await findPageByOfapiAccountId(app.db, row.ofapiAccountId)
    : null;
  if (!page) {
    return;
  }

  const binding = await getOfapiBindingPage(app.db, page.id);
  if (!binding || binding.account_id !== row.ofapiAccountId ||
      (row.bindingGeneration !== undefined && row.bindingGeneration !== binding.generation)) return;
  const occurredAt = ofapiAccountLifecycleTime(asRecord(row.payload?.payload) ?? {}, row.receivedAt);
  const authStatus = row.eventType.slice(OFAPI_ACCOUNT_EVENT_PREFIX.length);
  if (!OFAPI_AUTH_ALERT_STATUSES.has(authStatus) && !OFAPI_AUTH_RECOVERED_STATUSES.has(authStatus)) return;
  const advanced = await advancePageOfapiAuthStatus(app.db, {
    pageId: page.id,
    authStatus,
    changedAt: occurredAt,
  });
  if (!advanced) {
    // An out-of-order older event; the newer state already owns alerting.
    return;
  }

  if (OFAPI_AUTH_ALERT_STATUSES.has(authStatus)) {
    // Stage 26: action-required auth death parks the page's REST streams
    // (paused + blocker_kind='auth') so sync stops burning credits on a
    // dead vendor session. session_expired stays alert-only — OFAPI
    // recovers it silently and the session still works.
    if (OFAPI_AUTH_ACTION_REQUIRED_STATUSES.has(authStatus)) {
      await pausePageSyncForAuth(app.db, {
        pageId: page.id,
        streams: getSyncStreamsForPlatform(page.platform),
        blockerCode: `ofapi_${authStatus}`,
        blockerMessage: `OFAPI reported ${authStatus} for account ${row.ofapiAccountId ?? "unknown"}`,
        now: row.receivedAt,
      });
    }
    await app.db.execute(sql`
      update page_sync_states set blocker_ofapi_generation=${binding.generation}
      where page_id=${page.id} and blocker_kind='auth' and blocker_code=${`ofapi_${authStatus}`}
    `);
    await notifyOfapiAuthIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: page.platform,
      authStatus,
      occurredAt,
    });
  } else if (OFAPI_AUTH_RECOVERED_STATUSES.has(authStatus)) {
    // Clear this generation’s auth marker atomically without releasing the owner pause.
    await lockPageSyncStatesForPage(app.db, page.id);
    await app.db.execute(sql`
      update page_sync_states set blocker_kind=null,blocker_code=null,blocker_message=null,blocked_at=null,
        blocker_ofapi_generation=null,status=case when ofapi_user_paused then 'paused'::page_sync_status
          when request_seq>applied_seq then 'pending'::page_sync_status else 'idle'::page_sync_status end,
        retry_kind=null,retry_at=null,updated_at=${row.receivedAt}
      where page_id=${page.id} and blocker_kind='auth' and blocker_ofapi_generation=${binding.generation}
    `);
    await resolveOfapiAuthIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: page.platform,
      recoveredAt: occurredAt,
    });
  }
}

/**
 * Minutely health monitor (runs in the OFAPI sweep worker): low credit balance
 * against the last-observed _meta balance, webhook silence while mapped
 * pages exist, and the OnlyFans link series (written, mapped, no window
 * passed without an attempt). Incident dedupe keeps Telegram quiet between
 * state changes.
 */
export async function runOfapiAccountHealthMonitor(app: AppContext, now = new Date()) {
  if (!isOfapiAccountHealthEnabled(app.config)) {
    return;
  }

  try {
    // One effective-config snapshot covers both live keys read here, so the credit
    // threshold and webhook-silence threshold can never read from a half-applied mix.
    const effective = await loadEffectiveConfig(app.db, app.config);
    const creditAlertThreshold = effective.ofapiCreditAlertThreshold ??
      DEFAULT_CREDIT_ALERT_THRESHOLD;
    if (creditAlertThreshold > 0) {
      const credit = await getOfapiCreditState(app.db, now);
      if (credit.lastBalance !== null) {
        if (credit.lastBalance < creditAlertThreshold) {
          await notifyOfapiGlobalIncident(app, {
            kind: "ofapi_low_credit",
            errorSummary:
              `OFAPI credit balance ${credit.lastBalance} is below the alert threshold ${creditAlertThreshold}`,
            occurredAt: credit.lastBalanceAt ?? now,
          });
        } else {
          await resolveOfapiGlobalIncident(app, {
            kind: "ofapi_low_credit",
            recoveredAt: credit.lastBalanceAt ?? now,
          });
        }
      }
    } else {
      // Threshold disabled (<= 0): the low-credit alert is off, so clear any already-open
      // incident instead of leaving it falsely open after an operator zeroes the threshold.
      await resolveOfapiGlobalIncident(app, {
        kind: "ofapi_low_credit",
        recoveredAt: now,
      });
    }

    const mappedPages = await listOfapiMappedPages(app.db);
    if (mappedPages.length > 0) {
      const thresholdMs = Math.max(
        1,
        effective.ofapiWebhookSilenceThresholdMinutes ?? DEFAULT_WEBHOOK_SILENCE_THRESHOLD_MINUTES,
      ) * 60 * 1000;
      const latestEventAt = await getLatestOfapiWebhookEventReceivedAt(app.db);
      // No journal rows at all (fresh install or past retention) gives no
      // baseline to measure silence from — stay quiet rather than guess.
      if (latestEventAt !== null) {
        if (now.getTime() - latestEventAt.getTime() > thresholdMs) {
          await notifyOfapiGlobalIncident(app, {
            kind: "ofapi_webhook_silence",
            errorSummary: `No OFAPI webhook events received since ${latestEventAt.toISOString()} (${
              mappedPages.length
            } mapped page${mappedPages.length === 1 ? "" : "s"})`,
            occurredAt: now,
          });
        } else {
          await resolveOfapiGlobalIncident(app, {
            kind: "ofapi_webhook_silence",
            recoveredAt: latestEventAt,
          });
        }
      }
    }
  } catch (error) {
    app.logger.warn({ err: error }, "OFAPI account health monitor failed; continuing");
  }

  // Its own step, after the account checks: it never throws, and a failure
  // above must not keep the series from being watched.
  await runOfapiLinkStatsSeriesMonitor(app, { now, authNeedsAction: ofapiAuthStatusNeedsAction });
}

/** Serialize lifecycle effects with remap; resolving a page before a CAS alone
 * would still allow a late event to pause the replacement between statements. */
export async function applyOfapiAccountHealthEvent(app: AppContext, row: OfapiAccountEventRow) {
  if (!isOfapiAccountHealthEnabled(app.config) || !row.ofapiAccountId) return;
  const page = await findPageByOfapiAccountId(app.db, row.ofapiAccountId);
  if (!page) return;
  return withOfapiBindingLock(app.db, page.id, db => applyCurrentOfapiAccountHealthEvent({ ...app, db }, row));
}

/** Retry state is independent of journal settlement. A failed effect rolls back
 * the auth CAS too, so a retry can repair the complete transition. */
export async function runOfapiAccountHealthProjectionForSettledRow(app: AppContext, row: OfapiAccountEventRow) {
  if (!isOfapiAccountHealthEnabled(app.config) || !isOfapiAccountEventType(row.eventType) ||
      !["pending", "failed"].includes(row.projectionStatus ?? "")) return;
  try {
    await applyOfapiAccountHealthEvent(app, row);
    await markOfapiWebhookEventProjection(app.db, { id: row.id, status: "projected" });
  } catch (error) {
    app.logger.warn({ err: error, eventId: row.id }, "OFAPI account health projection failed; sweep will retry");
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id, status: "failed", error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
}

export async function sweepOfapiAccountHealthProjections(app: AppContext) {
  if (!isOfapiAccountHealthEnabled(app.config)) return 0;
  const rows = await listOfapiWebhookEventsForDmProjection(app.db, {
    eventTypes: OFAPI_ACCOUNT_HEALTH_EVENT_TYPES, maxAttempts: 5, limit: 200,
  });
  for (const row of rows) await runOfapiAccountHealthProjectionForSettledRow(app, row);
  return rows.length;
}
