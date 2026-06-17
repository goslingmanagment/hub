// OFAPI account health + credit ops (Phase 3 of docs/ofapi-integration-plan.md,
// D9): accounts.* webhook events project into pages.ofapi_auth_status
// (post-settle, never blocking the settle/fanout path), and the minutely OFAPI
// sweep checks the silent failure modes — low credit balance and webhook
// silence — opening/resolving debounced Telegram-backed notification incidents.
// Everything is gated by OFAPI_ACCOUNT_HEALTH_ENABLED (default off).

import {
  advancePageOfapiAuthStatus,
  findPageByOfapiAccountId,
  getLatestOfapiWebhookEventReceivedAt,
  getOfapiCreditState,
  listOfapiMappedPages,
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
}

/**
 * Post-settle projection of one accounts.* journal row: advance the page's
 * auth state (forward-only by receive time) and open/resolve the per-page
 * ofapi_auth incident. Best-effort — never throws into the event processor.
 */
export async function applyOfapiAccountHealthEvent(
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

    const authStatus = row.eventType.slice(OFAPI_ACCOUNT_EVENT_PREFIX.length);
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
      await notifyOfapiAuthIncident(app, {
        platformAccountId: page.id,
        pageLabel: page.label,
        platform: page.platform,
        authStatus,
        occurredAt: row.receivedAt,
      });
    } else if (OFAPI_AUTH_RECOVERED_STATUSES.has(authStatus)) {
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
