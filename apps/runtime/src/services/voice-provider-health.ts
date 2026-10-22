// The ElevenLabs account behind voice notes, watched for the owner: a rejected
// key, a lapsed subscription or characters running out used to show only in
// the logs while the chatter got «не получилось».
//
// Two producers move ONE set of latches — `ai_provider_billing` with the
// `elevenlabs:*` subKeys (notification-incidents.ts; a new incident kind would
// be a contract change an image rolled back to could not show), paged through
// the AI critical outbox: once when a condition starts, once when it clears.
//   * The account CHECK, every 30 min in the worker: one free GET of the
//     subscription (no synthesis) with the provider's own key over the service
//     egress the renders use. It runs only while the lane can render — the
//     provider was built at boot and `voiceNotesEnabled` is live — and it
//     opens AND resolves what it can see: the key, the subscription, the
//     characters. With the lane off it moves nothing (unknown is not healthy).
//   * A RENDER that ElevenLabs refuses for the account (voice-notes.ts) opens
//     its latch at once, without waiting for the check; the check resolves it
//     once the account is fine again. `refused` — a missing permission or a
//     blocked account, which the subscription read cannot see — resolves on
//     the next voice note that renders.
// A check that fails by itself (network, egress, 5xx, 429, an answer that is
// not a subscription) is not the account's: no latch moves, the log has
// counts only. Never logged or stored: the key, a response body, a script.

import {
  getVoiceProviderHealthState,
  insertOpsMetricSamples,
  recordVoiceProviderHealthCheck,
  type VoiceProviderHealthReading,
  type VoiceProviderHealthStateName,
} from "@agency_hub_core/db";
import type { AdminVoiceAccountResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { resolveEgress, type AppEgressContext } from "./egress/resolver.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import {
  openCriticalNotificationIncident,
  resolveCriticalNotificationIncident,
  VOICE_PROVIDER_INCIDENT_SUBKEYS,
  type IncidentApp,
  type VoiceProviderIncidentSubKey,
} from "./notification-incidents.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
import { resolveVoiceDailyCharBudgets } from "./voice-char-budget.ts";
import type {
  VoiceAccountReading,
  VoiceAccountRefusal,
  VoiceAccountSubscription,
  VoiceTtsProvider,
} from "./voice-elevenlabs-provider.ts";
import { resolveVoiceScriptMaxChars } from "./voice-script-validation.ts";

export const VOICE_PROVIDER_HEALTH_QUEUE = "voice.provider.health";

const COMPONENT = "voice_provider_health";
/** One GET; a check that takes longer has failed (by itself, not the account). */
const CHECK_TIMEOUT_MS = 15_000;
/** The subscription states that serve renders. Anything else — past_due,
 *  incomplete, free (the paid plan lapsed: no cloned voices), free_disabled,
 *  a state ElevenLabs adds later — is a subscription the owner must look at. */
const SERVING_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);
/** "Running low" = less than this many days of the most the hub may spend
 *  (the live global day budget)... */
const LOW_CHARACTERS_BUDGET_DAYS = 3;
/** ...capped at this share of the plan, so a budget sized near the plan
 *  cannot keep the latch open for the whole period. */
const LOW_CHARACTERS_MAX_PLAN_SHARE = 0.25;

const METRIC_CHARACTERS_USED = "vendor_elevenlabs_characters_used";
const METRIC_CHARACTERS_LIMIT = "vendor_elevenlabs_characters_limit";

export async function ensureVoiceProviderHealthQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, VOICE_PROVIDER_HEALTH_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureVoiceProviderHealthSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Every 30 min, at :07 and :37 — clear of the hourly :05 and :15 checks.
  await boss.schedule(VOICE_PROVIDER_HEALTH_QUEUE, "7,37 * * * *", null, { tz: "UTC" });
}

export interface VoiceCharacterThresholds {
  /** Fewer characters left than one whole voice note (the live script cap):
   *  the next voice note may be refused. */
  outChars: number;
  /** Fewer left than this: running low. Never below `outChars`. */
  lowChars: number;
}

/**
 * The two character lines a reading is judged by. Low = three days of the
 * live global day budget (the most the hub may spend), capped at a quarter of
 * the plan, never below one voice note. Production (2 000/day, a 131 000
 * plan, 600-character scripts): low under 6 000, out under 600.
 */
export function voiceCharacterThresholds(input: {
  scriptMaxChars: number;
  globalDailyCharBudget: number;
  characterLimit: number;
}): VoiceCharacterThresholds {
  const outChars = Math.max(1, Math.floor(input.scriptMaxChars));
  const byBudget = LOW_CHARACTERS_BUDGET_DAYS * Math.max(0, Math.floor(input.globalDailyCharBudget));
  const byPlan = Math.floor(LOW_CHARACTERS_MAX_PLAN_SHARE * Math.max(0, input.characterLimit));
  return { outChars, lowChars: Math.max(outChars, Math.min(byBudget, byPlan)) };
}

export interface VoiceAccountVerdict {
  /** The worst condition, for the owner's readout. */
  state: Extract<
    VoiceProviderHealthStateName,
    "healthy" | "characters_low" | "characters_out" | "subscription_inactive"
  >;
  charactersLeft: number;
  subscriptionServing: boolean;
  charactersOut: boolean;
  charactersLow: boolean;
}

/** One reading against the lines. Overage (count past the limit) is 0 left. */
export function judgeVoiceAccount(
  subscription: VoiceAccountSubscription,
  thresholds: VoiceCharacterThresholds,
): VoiceAccountVerdict {
  const charactersLeft = Math.max(0, subscription.characterLimit - subscription.characterCount);
  const subscriptionServing = SERVING_SUBSCRIPTION_STATUSES.has(subscription.status);
  const charactersOut = charactersLeft < thresholds.outChars;
  const charactersLow = charactersLeft < thresholds.lowChars;
  return {
    state: !subscriptionServing
      ? "subscription_inactive"
      : charactersOut ? "characters_out" : charactersLow ? "characters_low" : "healthy",
    charactersLeft,
    subscriptionServing,
    charactersOut,
    charactersLow,
  };
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function utcMinute(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function resetClause(subscription: VoiceAccountSubscription): string {
  return subscription.nextResetAt ? `resets ${utcMinute(subscription.nextResetAt)}` : "ElevenLabs names no reset date";
}

function httpReason(httpStatus: number, reason: string | null): string {
  return reason ? `HTTP ${httpStatus} ${reason}` : `HTTP ${httpStatus}`;
}

/** What each refusal asks of the owner — the tail of every summary. */
const REFUSAL_ACTION: Record<VoiceAccountRefusal, string> = {
  key_rejected: "the key in ELEVENLABS_API_KEY is not accepted. Replace it on the server and restart the runtime.",
  account_refused: "the key lacks a permission (text_to_speech) or ElevenLabs blocked the account. "
    + "The next voice note that renders closes this.",
  subscription_inactive: "the ElevenLabs plan does not allow it. Renew or upgrade the plan in ElevenLabs.",
  out_of_characters: "no characters left. Top up or upgrade in ElevenLabs, or wait for the reset.",
};

const REFUSAL_LATCH: Record<VoiceAccountRefusal, VoiceProviderIncidentSubKey> = {
  key_rejected: VOICE_PROVIDER_INCIDENT_SUBKEYS.key,
  account_refused: VOICE_PROVIDER_INCIDENT_SUBKEYS.refused,
  subscription_inactive: VOICE_PROVIDER_INCIDENT_SUBKEYS.subscription,
  out_of_characters: VOICE_PROVIDER_INCIDENT_SUBKEYS.charactersOut,
};

async function openVoiceLatch(
  app: IncidentApp,
  input: { subKey: VoiceProviderIncidentSubKey; errorCode: string; errorSummary: string; at: Date },
) {
  await openCriticalNotificationIncident(app, {
    kind: "ai_provider_billing",
    platformAccountId: null,
    pageLabel: null,
    platform: null,
    subKey: input.subKey,
    errorCode: input.errorCode,
    errorSummary: input.errorSummary,
    occurredAt: input.at,
  });
}

async function resolveVoiceLatch(app: IncidentApp, subKey: VoiceProviderIncidentSubKey, at: Date) {
  await resolveCriticalNotificationIncident(app, {
    kind: "ai_provider_billing",
    platformAccountId: null,
    pageLabel: null,
    platform: null,
    subKey,
    recoveredAt: at,
  });
}

/**
 * A render ElevenLabs refused for the account: page the owner now, through
 * the latch the account check keeps for the same condition. Never throws —
 * paging is downstream of the chatter's answer and the reservation refund.
 */
export async function reportVoiceProviderRenderRefusal(
  app: IncidentApp,
  input: { refusal: VoiceAccountRefusal; httpStatus: number; reason: string | null; occurredAt: Date },
): Promise<void> {
  try {
    app.logger.warn({
      component: COMPONENT,
      event: "voice_provider_account_refused",
      refusal: input.refusal,
      providerStatus: input.httpStatus,
      reason: input.reason,
    }, "ElevenLabs refused a voice note for the account; paging the owner");
    await openVoiceLatch(app, {
      subKey: REFUSAL_LATCH[input.refusal],
      errorCode: input.reason ?? input.refusal,
      errorSummary: `A voice note was refused with ${httpReason(input.httpStatus, input.reason)}: `
        + REFUSAL_ACTION[input.refusal],
      at: input.occurredAt,
    });
  } catch (error) {
    app.logger.warn({ component: COMPONENT, err: error }, "ElevenLabs account refusal could not be paged; continuing");
  }
}

/**
 * A voice note rendered: ElevenLabs serves the account, so a `refused` latch
 * (a condition the account check cannot see) is over. Never throws.
 */
export async function reportVoiceProviderRenderServed(app: IncidentApp, at: Date): Promise<void> {
  try {
    await resolveVoiceLatch(app, VOICE_PROVIDER_INCIDENT_SUBKEYS.refused, at);
  } catch (error) {
    app.logger.warn({ component: COMPONENT, err: error }, "ElevenLabs render recovery could not be recorded; continuing");
  }
}

type AccountReader = NonNullable<VoiceTtsProvider["readAccount"]>;

/** One GET over a fresh service-egress dispatcher, closed after. An egress
 *  that cannot be resolved is the check's own failure (status 0). */
async function readVoiceAccount(
  app: Pick<AppContext, "db" | "config" | "logger">,
  readAccount: AccountReader,
): Promise<VoiceAccountReading> {
  let egress: AppEgressContext | undefined;
  try {
    egress = await resolveEgress(app, { kind: "vendor", vendor: "elevenlabs" });
    if (!egress.dispatcher) {
      throw new Error("ElevenLabs service egress resolved without a dispatcher");
    }
    return await readAccount({
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      dispatcher: egress.dispatcher,
    });
  } catch (error) {
    app.logger.warn({ component: COMPONENT, err: error }, "ElevenLabs account check could not resolve its egress");
    return { ok: false, httpStatus: 0, failureKind: "connect", refusal: null, reason: null };
  } finally {
    await egress?.close().catch(() => undefined);
  }
}

/** Best-effort: a write that fails never costs the owner the page. */
async function recordCheck(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    state: VoiceProviderHealthStateName;
    checkedAt: Date;
    httpStatus: number | null;
    reading: VoiceProviderHealthReading | null;
  },
) {
  try {
    await recordVoiceProviderHealthCheck(app.db, input);
  } catch (error) {
    app.logger.warn({ component: COMPONENT, err: error }, "ElevenLabs account check could not record its answer; continuing");
  }
  if (!input.reading) {
    return;
  }
  // The history beside the disk gauges: one sample per reading. `vendor_*`
  // is outside the sampler deadman (getLatestOpsMetricSampleAt) and outside
  // the golden-signal thresholds: nothing pages on these rows.
  try {
    await insertOpsMetricSamples(app.db, [
      {
        metric: METRIC_CHARACTERS_USED,
        quantile: "p95",
        valueMs: input.reading.characterCount,
        sampledAt: input.checkedAt,
      },
      {
        metric: METRIC_CHARACTERS_LIMIT,
        quantile: "p95",
        valueMs: input.reading.characterLimit,
        sampledAt: input.checkedAt,
      },
    ]);
  } catch (error) {
    app.logger.warn({ component: COMPONENT, err: error }, "ElevenLabs account check could not record its samples; continuing");
  }
}

export type VoiceProviderHealthCheckResult =
  | { skipped: "no_provider" | "disabled" }
  | {
      skipped: null;
      state: VoiceProviderHealthStateName;
      checkedAt: Date;
      httpStatus: number | null;
      charactersLeft: number | null;
    };

/**
 * The 30-minute account check. Reads the subscription once, records the
 * answer for the owner's readout, and moves the latches it can see. Never
 * throws for the account or the network; the log carries counts and codes.
 */
export async function runVoiceProviderHealthCheck(
  app: Pick<AppContext, "db" | "config" | "logger" | "voiceTtsProvider">,
  options?: { now?: Date },
): Promise<VoiceProviderHealthCheckResult> {
  const readAccount = app.voiceTtsProvider?.readAccount;
  if (!readAccount) {
    return { skipped: "no_provider" };
  }
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.voiceNotesEnabled !== true) {
    return { skipped: "disabled" };
  }

  // The reading's time is the check's START: a render refused after it is
  // newer than this answer, so a resolve stamped here never hides it.
  const checkedAt = options?.now ?? new Date();
  const reading = await readVoiceAccount(app, readAccount);

  if (!reading.ok) {
    const state: VoiceProviderHealthStateName = reading.refusal === null
      ? "check_failed"
      : reading.refusal === "account_refused"
        ? "unreadable"
        : reading.refusal === "out_of_characters"
          ? "characters_out"
          : reading.refusal;
    await recordCheck(app, { state, checkedAt, httpStatus: reading.httpStatus, reading: null });
    app.logger.warn({
      component: COMPONENT,
      state,
      failureKind: reading.failureKind,
      providerStatus: reading.httpStatus,
      reason: reading.reason,
    }, state === "check_failed" || state === "unreadable"
      ? "ElevenLabs account check could not read the account; no latch moved"
      : "ElevenLabs refused the account check for the account; paging the owner");
    // A refusal of the account itself pages; a check that could not read
    // (its own failure, or a key without `user_read`) moves no latch.
    if (reading.refusal !== null && reading.refusal !== "account_refused") {
      await openVoiceLatch(app, {
        subKey: REFUSAL_LATCH[reading.refusal],
        errorCode: reading.reason ?? reading.refusal,
        errorSummary: `ElevenLabs answered the account check with ${httpReason(reading.httpStatus, reading.reason)}: `
          + REFUSAL_ACTION[reading.refusal],
        at: checkedAt,
      });
    }
    return { skipped: null, state, checkedAt, httpStatus: reading.httpStatus, charactersLeft: null };
  }

  const { subscription } = reading;
  const thresholds = voiceCharacterThresholds({
    scriptMaxChars: resolveVoiceScriptMaxChars(effective),
    globalDailyCharBudget: resolveVoiceDailyCharBudgets(effective).globalBudget,
    characterLimit: subscription.characterLimit,
  });
  const verdict = judgeVoiceAccount(subscription, thresholds);
  await recordCheck(app, {
    state: verdict.state,
    checkedAt,
    httpStatus: null,
    reading: {
      tier: subscription.tier,
      subscriptionStatus: subscription.status,
      characterCount: subscription.characterCount,
      characterLimit: subscription.characterLimit,
      nextResetAt: subscription.nextResetAt,
      lowThresholdChars: thresholds.lowChars,
    },
  });

  const left = `${count(verdict.charactersLeft)} of ${count(subscription.characterLimit)} characters left`;
  // The key answered: whatever opened its latch is over.
  await resolveVoiceLatch(app, VOICE_PROVIDER_INCIDENT_SUBKEYS.key, checkedAt);
  if (verdict.subscriptionServing) {
    await resolveVoiceLatch(app, VOICE_PROVIDER_INCIDENT_SUBKEYS.subscription, checkedAt);
  } else {
    await openVoiceLatch(app, {
      subKey: VOICE_PROVIDER_INCIDENT_SUBKEYS.subscription,
      errorCode: subscription.status,
      errorSummary: `ElevenLabs subscription is ${subscription.status}`
        + `${subscription.tier ? ` (${subscription.tier})` : ""}: renew or pay it in ElevenLabs. ${left}.`,
      at: checkedAt,
    });
  }
  if (verdict.charactersOut) {
    await openVoiceLatch(app, {
      subKey: VOICE_PROVIDER_INCIDENT_SUBKEYS.charactersOut,
      errorCode: "characters_out",
      errorSummary: `${left}, less than one voice note (${count(thresholds.outChars)}); `
        + `${resetClause(subscription)}. Top up or upgrade in ElevenLabs.`,
      at: checkedAt,
    });
  } else {
    await resolveVoiceLatch(app, VOICE_PROVIDER_INCIDENT_SUBKEYS.charactersOut, checkedAt);
  }
  if (verdict.charactersLow) {
    await openVoiceLatch(app, {
      subKey: VOICE_PROVIDER_INCIDENT_SUBKEYS.charactersLow,
      errorCode: "characters_low",
      errorSummary: `${left} (alert under ${count(thresholds.lowChars)}); ${resetClause(subscription)}.`,
      at: checkedAt,
    });
  } else {
    await resolveVoiceLatch(app, VOICE_PROVIDER_INCIDENT_SUBKEYS.charactersLow, checkedAt);
  }

  app.logger.info({
    component: COMPONENT,
    state: verdict.state,
    subscriptionStatus: subscription.status,
    charactersUsed: subscription.characterCount,
    charactersLimit: subscription.characterLimit,
    charactersLeft: verdict.charactersLeft,
    lowThresholdChars: thresholds.lowChars,
    outThresholdChars: thresholds.outChars,
  }, "ElevenLabs account check complete");
  return { skipped: null, state: verdict.state, checkedAt, httpStatus: null, charactersLeft: verdict.charactersLeft };
}

/** The owner's readout of the account (the AI usage page): the last check's
 *  answer and the last reading. Database only — never asks ElevenLabs. */
export async function getAdminVoiceAccountReport(
  app: Pick<AppContext, "db" | "config" | "voiceTtsProvider">,
  now = new Date(),
): Promise<AdminVoiceAccountResponse> {
  const [effective, row] = await Promise.all([
    loadEffectiveConfig(app.db, app.config),
    getVoiceProviderHealthState(app.db),
  ]);
  return {
    generatedAt: now.toISOString(),
    configured: app.voiceTtsProvider != null,
    enabled: effective.voiceNotesEnabled === true,
    check: row
      ? {
        state: row.state,
        checkedAt: row.checkedAt.toISOString(),
        httpStatus: row.httpStatus,
        readAt: row.readAt?.toISOString() ?? null,
        tier: row.tier,
        subscriptionStatus: row.subscriptionStatus,
        charactersUsed: row.characterCount,
        charactersLimit: row.characterLimit,
        nextResetAt: row.nextResetAt?.toISOString() ?? null,
        lowThresholdChars: row.lowThresholdChars,
      }
      : null,
  };
}
