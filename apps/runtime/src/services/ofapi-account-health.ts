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
  getOfapiBindingPage,
  findPageByOfapiAccountId,
  getLatestOfapiWebhookEventReceivedAt,
  getOfapiCreditState,
  getSyncStreamsForPlatform,
  listOfapiMappedPages,
  pausePageSyncForAuth,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import {
  notifyOfapiAuthIncident,
  notifyOfapiGlobalIncident,
  resolveOfapiAuthIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";

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
  return eventType.startsWith(OFAPI_ACCOUNT_EVENT_PREFIX);
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
}

/**
 * Post-settle projection of one accounts.* journal row: advance the page's
 * auth state (forward-only by receive time) and open/resolve the per-page
 * ofapi_auth incident. Best-effort — never throws into the event processor.
 */
async function applyCurrentOfapiAccountHealthEvent(
  app: AppContext,
  row: OfapiAccountEventRow,
) {
  if (!isOfapiAccountHealthEnabled(app.config) || !isOfapiAccountEventType(row.eventType)) {
    return;
  }

  try {
    const page = row.ofapiAccountId
      ? await findPageByOfapiAccountId(app.db, row.ofapiAccountId)
      : null;
    if (!page) {
      return;
    }

    const binding = await getOfapiBindingPage(app.db, page.id);
    if (!binding || binding.account_id !== row.ofapiAccountId ||
        (row.bindingGeneration !== undefined && row.bindingGeneration !== binding.generation)) return;
    const authStatus = row.eventType.slice(OFAPI_ACCOUNT_EVENT_PREFIX.length);
    if (!OFAPI_AUTH_ALERT_STATUSES.has(authStatus) && !OFAPI_AUTH_RECOVERED_STATUSES.has(authStatus)) return;
    const advanced = await advancePageOfapiAuthStatus(app.db, {
      pageId: page.id,
      authStatus,
      changedAt: row.receivedAt,
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
        occurredAt: row.receivedAt,
      });
    } else if (OFAPI_AUTH_RECOVERED_STATUSES.has(authStatus)) {
      // Stage 26: vendor-signaled recovery is the OFAPI-side re-verify —
      // release the auth pause the same way credential re-verify does.
      // Only this generation owns these pauses. Older or operator blockers survive.
      await app.db.execute(sql`
        update page_sync_states set blocker_kind=null,blocker_code=null,blocker_message=null,blocked_at=null,
          blocker_ofapi_generation=null,status=case when request_seq>applied_seq then 'pending'::page_sync_status else 'idle'::page_sync_status end,
          retry_kind=null,retry_at=null,updated_at=${row.receivedAt}
        where page_id=${page.id} and blocker_kind='auth' and blocker_ofapi_generation=${binding.generation} and not ofapi_user_paused
      `);
      await resolveOfapiAuthIncident(app, {
        platformAccountId: page.id,
        pageLabel: page.label,
        platform: page.platform,
        recoveredAt: row.receivedAt,
      });
    }
  } catch (error) {
    app.logger.warn(
      { err: error, eventId: row.id, eventType: row.eventType },
      "OFAPI account health projection failed; continuing",
    );
  }
}

/**
 * Minutely health monitor (runs in the OFAPI sweep worker): low credit balance
 * against the last-observed _meta balance, and webhook silence while mapped
 * pages exist. Incident dedupe keeps Telegram quiet between state changes.
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
}

/** Serialize lifecycle effects with remap; resolving a page before a CAS alone
 * would still allow a late event to pause the replacement between statements. */
export async function applyOfapiAccountHealthEvent(app: AppContext, row: OfapiAccountEventRow) {
  if (!isOfapiAccountHealthEnabled(app.config) || !row.ofapiAccountId) return;
  const page = await findPageByOfapiAccountId(app.db, row.ofapiAccountId);
  if (!page) return;
  return withOfapiBindingLock(app.db, page.id, db => applyCurrentOfapiAccountHealthEvent({ ...app, db }, row));
}
