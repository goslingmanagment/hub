import {
  hasRecentTerminalProxyFailure,
  isFanslyPageEngineOwned,
  listNotificationIncidents,
  openNotificationIncidentWithRecoveryGuard,
  recoverAndResolveNotificationIncident,
  type NotificationIncidentKind,
  type SyncStream,
} from "@agency_hub_core/db";
import { sanitizeError, type SanitizeErrorOptions } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";

const STREAM_FAILURE_THRESHOLD = 3;
const INCIDENT_ERROR_OPTIONS = {
  maxChars: 240,
  truncation: "ellipsis",
  trim: true,
} satisfies SanitizeErrorOptions;
// Attempt cap per critical outbox row (Decision 186).
const MAX_OPEN_DELIVERY_ATTEMPTS = 5;
// Decision 381: producers only flip latches. Every kind outside the AI
// critical pair is paged by the minutely paging sweep
// (`notification-paging-sweep.ts`) through the durable outbox, so no producer
// here needs Telegram credentials or runtime config any more. The exported
// signatures keep accepting `config` so the many call sites stay unchanged.
/** Global latches of the AI media describer under `ai_provider_failed`. */
export const AI_MEDIA_DESCRIBE_BREAKER_SUBKEY = "media_describe_breaker";
export const AI_MEDIA_DESCRIBE_ACCOUNT_STOP_SUBKEY = "media_describe_account_stop";
/** The Fansly fast lane's "unavailable > 10 min" latch. The lane is deleted
 * (step 4, S4-12): nothing opens it any more, and one an older build left
 * open resolves on the describer's next sweep. */
export const AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY = "media_describe_fast_lane";
/** Plan §2.5/§10: the page-scoped latches of the Fansly send guard, under the
 * Fansly-only `sync_silent` kind (a new kind is a contract change). A closed
 * page sends nothing — its sync is silent — until the holder of its last
 * request completes or is confirmed gone. */
export const FANSLY_SEND_GUARD_CLOSED_SUBKEY = "send_guard_closed";
/** Plan §2.4/§10: two sends of one page closer than the pause setting. Must
 * never happen; the latch stays open for an hour after the last one seen. */
export const FANSLY_PACE_VIOLATION_SUBKEY = "pace_violation";
/** Traffic sources plan §2.10: the page-scoped latches of the OnlyFans link
 * series, under the kind its failed pass already has (a new kind is a
 * contract change: an image rolled back to cannot show it). The kind's own
 * latch — no subKey, global — stays the single failed pass.
 *   series_stale   a (page, link kind) has had no usable result for two
 *                  windows and more: the series is not being written;
 *   page_unmapped  an active OnlyFans page has no OFAPI account mapping. */
export const OFAPI_LINK_STATS_SERIES_STALE_SUBKEY = "series_stale";
export const OFAPI_LINK_STATS_PAGE_UNMAPPED_SUBKEY = "page_unmapped";
export type OfapiLinkStatsPageSubKey =
  | typeof OFAPI_LINK_STATS_SERIES_STALE_SUBKEY
  | typeof OFAPI_LINK_STATS_PAGE_UNMAPPED_SUBKEY;
/** Plan §10, design §9.6: the Fansly Sync Engine's five alerts, one subKey
 * each under the kind `fansly_sync_engine` (0233). 1–4 are page-scoped, 5
 * (`process`) is global. */
export const SYNC_ENGINE_ALERT_SUBKEYS = ["page_stopped", "live_degraded", "freshness", "stuck", "process"] as const;
export type SyncEngineAlertSubKey = (typeof SYNC_ENGINE_ALERT_SUBKEYS)[number];
/** Alert 1's pace-violation latch: its own key (a refresh of `page_stopped`
 * for a 429 must not overwrite it, and that latch resolves by itself once the
 * page is clean), resolved only by the owner (`pnpm cli sync alerts ack`). */
export const SYNC_ENGINE_PACE_VIOLATION_SUBKEY = "page_stopped:pace_violation";
/** Step 3b D5 / owner decision №23: a 429 (or a 5xx naming its `Retry-After`)
 * holds one route of a page — its own latch per page+route, opened on the
 * route's first 429 and refreshed, never repeated, by the next ones; resolved
 * 10 clean minutes after its hold ends (the route keeps running slowed until
 * the owner raises it). */
export const SYNC_ENGINE_ROUTE_SUBKEY_PREFIX = "route_limited:";
export type SyncEngineRouteSubKey = `${typeof SYNC_ENGINE_ROUTE_SUBKEY_PREFIX}${string}`;
export type SyncEngineIncidentSubKey = SyncEngineAlertSubKey | typeof SYNC_ENGINE_PACE_VIOLATION_SUBKEY | SyncEngineRouteSubKey;

/** The latch subKey of one route's incident. */
export function syncEngineRouteSubKey(route: string): SyncEngineRouteSubKey {
  return `${SYNC_ENGINE_ROUTE_SUBKEY_PREFIX}${route}`;
}

const SYNC_ENGINE_ROUTE_OPEN_TITLE = "🚨 Fansly Sync Engine route held: a 429 stops one endpoint of a page "
  + "(the rest runs; the endpoint then runs at half rate until raised)";
const SYNC_ENGINE_ROUTE_RESOLVE_DETAIL = "Fansly Sync Engine route open again (10 min clean; its slowdown stays until raised)";

const SYNC_ENGINE_OPEN_TITLES: Record<SyncEngineAlertSubKey | typeof SYNC_ENGINE_PACE_VIOLATION_SUBKEY, string> = {
  page_stopped: "🚨 Fansly Sync Engine stopped a page (429, auth, identity, network or ownership)",
  [SYNC_ENGINE_PACE_VIOLATION_SUBKEY]: "🚨 Fansly Sync Engine pace violated: two sends of a page closer than their pause, or of a route closer than its interval",
  live_degraded: "🚨 Fansly Sync Engine live path degraded (socket, decode debt or quarantined work)",
  freshness: "🚨 Fansly Sync Engine freshness broken (messages, money or urgent work late)",
  stuck: "🚨 Fansly Sync Engine work stuck (a request or a planned resource without progress)",
  process: "🚨 Fansly Sync Engine process silent — no sync heartbeat for 2 min while a page is in the engine",
};

const SYNC_ENGINE_RESOLVE_DETAILS: Record<SyncEngineAlertSubKey | typeof SYNC_ENGINE_PACE_VIOLATION_SUBKEY, string> = {
  page_stopped: "Fansly Sync Engine page running again (10 min clean)",
  [SYNC_ENGINE_PACE_VIOLATION_SUBKEY]: "Fansly Sync Engine pace violation acknowledged by the owner",
  live_degraded: "Fansly Sync Engine live path healthy again",
  freshness: "Fansly Sync Engine freshness back within bounds",
  stuck: "Fansly Sync Engine work progressing again",
  process: "Fansly Sync Engine heartbeat back",
};

/** Why a latch was resolved when the resolve is not its condition's own
 *  recovery: stored as the resolved row's `metadata.resolution` (a reopen
 *  replaces the metadata, so it never outlives the episode it closed) and
 *  named by the resolve message the paging sweep sends. */
export const INCIDENT_RESOLUTION_REASONS = {
  /** A legacy stream's latch on a page the Fansly Sync Engine runs live: the
   *  legacy executor no longer runs the stream, so its own recovery — the only
   *  thing that resolved it — never comes. */
  engine_owned: "the page is owned by the Fansly Sync Engine; the legacy stream no longer runs",
} as const;
export type IncidentResolution = keyof typeof INCIDENT_RESOLUTION_REASONS;

function incidentResolutionReason(resolution: string | null | undefined): string | null {
  return resolution !== null && resolution !== undefined && Object.hasOwn(INCIDENT_RESOLUTION_REASONS, resolution)
    ? INCIDENT_RESOLUTION_REASONS[resolution as IncidentResolution]
    : null;
}

function syncEngineSubKey(subKey: string | null | undefined): keyof typeof SYNC_ENGINE_OPEN_TITLES | null {
  return subKey !== null && subKey !== undefined && Object.hasOwn(SYNC_ENGINE_OPEN_TITLES, subKey)
    ? subKey as keyof typeof SYNC_ENGINE_OPEN_TITLES
    : null;
}

function isSyncEngineRouteSubKey(subKey: string | null | undefined): subKey is SyncEngineRouteSubKey {
  return subKey !== null && subKey !== undefined && subKey.startsWith(SYNC_ENGINE_ROUTE_SUBKEY_PREFIX)
    && subKey.length > SYNC_ENGINE_ROUTE_SUBKEY_PREFIX.length;
}

/** What a producer needs: the database and somewhere to say that an open or
 *  resolve failed (any logger with a structured `warn`). */
export type IncidentApp = Pick<AppContext, "db"> & {
  logger: { warn(obj: object, msg?: string): void };
};
type CriticalIncidentApp = IncidentApp;

export function incidentKey(
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    stream?: SyncStream | null;
    subKey?: string | null;
  },
) {
  if (input.platformAccountId === null) {
    // Account-global OFAPI incidents (low credit, webhook silence).
    // W5.1 (A25): an optional subKey splits the latch per condition —
    // golden_signal_lag:global:<metric> — so a standing breach on one
    // signal can no longer mask every other signal behind one shared key.
    return input.subKey
      ? `${input.kind}:global:${input.subKey}`
      : `${input.kind}:global`;
  }
  const pageKey = input.kind === "stream_failed_threshold" && input.stream
    ? `${input.kind}:${input.platformAccountId}:${input.stream}`
    : `${input.kind}:${input.platformAccountId}`;
  // No pre-Stage-1A caller combined a page id with subKey, so adding the
  // suffix fixes the silently-colliding shape without changing an existing
  // latch identity. Stream keeps its historical position before the suffix.
  return input.subKey ? `${pageKey}:${input.subKey}` : pageKey;
}

function openTitleForIncident(
  input: { kind: NotificationIncidentKind; subKey?: string | null },
) {
  // A kind whose subKeys latch DIFFERENT conditions must not open under one
  // title: the owner reads the first line and acts on it. Same reason the
  // resolve text below is subKey-specific.
  if (input.kind === "capture_payload_parity" && input.subKey === "sha256_collision") {
    return "🚨 Capture payload sha256 collision";
  }
  // #222. The most consequential of the three conditions under this kind since
  // #220: a reference into a hole on a row with no inline body is a captured
  // fact nobody can read, which is a different emergency from "the two copies
  // disagree" and must not open under that title.
  if (input.kind === "capture_payload_parity" && input.subKey === "dangling_reference") {
    return "🚨 Capture payload reference points at nothing";
  }
  // H2: the automatic webhook redelivery cap is a spend bound, not an hourly
  // burn rate; it shares the kind (a new kind is a contract change) but not
  // the title or the latch.
  if (input.kind === "ofapi_burn_rate" && input.subKey === "auto_redelivery_cap") {
    return "🚨 OFAPI webhook auto-redelivery daily cap reached";
  }
  // AI media describer (docs/runbooks/ai-media-describe.md): two global
  // latches under the AI kind (a new kind is a contract change), each with
  // its own title so the owner reads what actually stopped.
  if (input.kind === "ai_provider_failed" && input.subKey === AI_MEDIA_DESCRIBE_BREAKER_SUBKEY) {
    return "🚨 AI image describer paused for the day: too many refusals";
  }
  if (input.kind === "ai_provider_failed" && input.subKey === AI_MEDIA_DESCRIBE_ACCOUNT_STOP_SUBKEY) {
    return "🚨 AI image describer stopped: provider rejected the key (401/403)";
  }
  if (input.kind === "ai_provider_failed" && input.subKey === AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY) {
    return "⚠️ Fansly image fast lane unavailable for over 10 minutes";
  }
  // The send guard's latches share the Fansly-only kind, not its title: a
  // closed page and a pace violation each say what happened and what to do.
  if (input.kind === "sync_silent" && input.subKey === FANSLY_SEND_GUARD_CLOSED_SUBKEY) {
    return "🚨 Fansly page closed: a request overran its lease, nothing is sent for the page";
  }
  if (input.kind === "sync_silent" && input.subKey === FANSLY_PACE_VIOLATION_SUBKEY) {
    return "🚨 Fansly pace violated: two requests of a page closer than the pause setting";
  }
  // The link series' page latches say what is wrong with the page, not that
  // "a reconcile failed": nothing may have run at all.
  if (input.kind === "ofapi_link_stats_reconcile_failed" && input.subKey === OFAPI_LINK_STATS_SERIES_STALE_SUBKEY) {
    return "🚨 OnlyFans link series is not being written";
  }
  if (input.kind === "ofapi_link_stats_reconcile_failed" && input.subKey === OFAPI_LINK_STATS_PAGE_UNMAPPED_SUBKEY) {
    return "🚨 OnlyFans page has no OFAPI account mapping";
  }
  // The engine's alerts: one kind, a title per alert — the owner acts on the
  // first line.
  if (input.kind === "fansly_sync_engine") {
    if (isSyncEngineRouteSubKey(input.subKey)) return SYNC_ENGINE_ROUTE_OPEN_TITLE;
    const subKey = syncEngineSubKey(input.subKey);
    return subKey === null ? "🚨 Fansly Sync Engine alert" : SYNC_ENGINE_OPEN_TITLES[subKey];
  }
  switch (input.kind) {
    case "auth_blocked":
      return "🚨 Auth failed";
    case "proxy_failed":
      return "🚨 Proxy failed";
    case "proxy_missing":
      return "🚨 Fansly proxy missing — sync refused (fail-closed)";
    case "stream_failed_threshold":
      return "🚨 Stream sync failed";
    case "ofapi_auth":
      return "🚨 OFAPI account auth needs attention";
    case "ofapi_low_credit":
      return "🚨 OFAPI credit balance low";
    case "ofapi_binding_conflict":
      return "🚨 OFAPI account claimed by two pages";
    case "ofapi_webhook_silence":
      return "🚨 OFAPI webhooks silent";
    case "ofapi_burn_rate":
      return "🚨 OFAPI credit burn rate high";
    case "db_disk_usage":
      return "🚨 Server disk usage high";
    case "observations_partitions":
      return "🚨 Observations partition lead too short";
    case "wrong_transactions_writer":
      return "🚨 Wrong transactions writer refused";
    case "read_gateway_capture":
      return "🚨 Read-gateway capture tee dropping";
    case "golden_signal_lag":
      return "🚨 Golden-signal lag over threshold";
    case "scheduler_silent":
      return "🚨 Scheduler heartbeat silent — cron is not firing";
    case "ops_sampler_silent":
      return "🚨 Golden-signal sampler silent — ops telemetry is blind";
    case "sync_silent":
      return "🚨 Fansly sync silent — no chunk is starting";
    case "ofapi_chargebacks_reconcile_failed":
      return "🚨 OFAPI chargebacks reconcile failed";
    case "ofapi_link_stats_reconcile_failed":
      return "🚨 OFAPI link-stats reconcile failed";
    case "ai_provider_billing":
      return "🚨 AI provider billing needs attention";
    case "ai_provider_failed":
      return "🚨 AI provider generation failed";
    case "capture_payload_parity":
      return "🚨 Capture payload copy disagrees with the inline fact";
  }
}

/** The open title without its siren, for the daily digest's lines. */
export function incidentTitleForKind(
  input: { kind: NotificationIncidentKind; subKey?: string | null },
): string {
  return openTitleForIncident(input).replace(/^🚨\s*/u, "");
}

/**
 * Recovers the `subKey` from a stored incident key (the row does not keep it
 * as a column). Shapes, from `incidentKey` above:
 * `kind:global[:subKey]` and `kind:<pageId>[:<stream>][:subKey]`, where the
 * stream segment is present exactly when it equals the row's stream column.
 */
export function parseIncidentSubKey(
  input: { incidentKey: string; kind: NotificationIncidentKind; stream: string | null },
): string | null {
  const prefix = `${input.kind}:`;
  if (!input.incidentKey.startsWith(prefix)) {
    return null;
  }
  const segments = input.incidentKey.slice(prefix.length).split(":");
  // segments[0] is "global" or the page id; drop it.
  let rest = segments.slice(1);
  if (segments[0] !== "global" && input.stream !== null && rest[0] === input.stream) {
    rest = rest.slice(1);
  }
  return rest.length > 0 ? rest.join(":") : null;
}

export function openMessageForIncident(
  input: {
    kind: NotificationIncidentKind;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    subKey?: string | null;
    errorSummary: string | null;
  },
) {
  return [
    openTitleForIncident(input),
    ...(input.pageLabel ? [`Page: ${input.pageLabel}${input.platform ? ` (${input.platform})` : ""}`] : []),
    ...(input.stream ? [`Stream: ${input.stream}`] : []),
    `Error: ${sanitizeError(
      input.errorSummary || "Unknown error",
      INCIDENT_ERROR_OPTIONS,
    ).message}`,
  ].join("\n");
}

/** Exhaustive over NotificationIncidentKind — a missing case is a compile
 * error, not a fallthrough into another kind's text (review R2-7: the old
 * ternary resolved golden_signal_lag as "OFAPI webhooks delivering again"). */
function resolveDetailForIncident(
  input: { kind: NotificationIncidentKind; stream?: SyncStream | null; subKey?: string | null; resolution?: string | null },
): string {
  switch (input.kind) {
    case "auth_blocked":
      return "Auth failed";
    case "proxy_failed":
      return "Proxy failed";
    case "proxy_missing":
      return "Proxy assigned; Fansly egress restored";
    case "stream_failed_threshold":
      // Closed, not recovered: the stream stopped running (its reason is the
      // message's own line), so nothing says it succeeded again.
      return incidentResolutionReason(input.resolution) === null
        ? `Stream ${input.stream ?? "unknown"} recovered`
        : `Stream ${input.stream ?? "unknown"} closed`;
    case "ofapi_auth":
      return "OFAPI account auth recovered";
    case "ofapi_low_credit":
      return "OFAPI credit balance recovered";
    case "ofapi_burn_rate":
      if (input.subKey === "auto_redelivery_cap") {
        return "OFAPI webhook auto-redelivery below its daily cap again; the burn-rate latch is unaffected";
      }
      return "OFAPI credit burn rate back to normal";
    case "db_disk_usage":
      // The runway latches share the kind but not the condition: resolving a
      // runway subKey while the 80% latch (or the other runway latch) is still
      // open must not read as a disk-wide all-clear.
      if (input.subKey === "runway_critical") {
        return "Disk runway back above the critical threshold (7 days); usage latches unaffected";
      }
      if (input.subKey === "runway_warning") {
        return "Disk runway back above the warning threshold (30 days); usage latches unaffected";
      }
      return "Server disk usage back under the threshold";
    case "observations_partitions":
      return "Observations partition lead restored";
    case "ofapi_binding_conflict":
      return "OFAPI binding custody conflict cleared";
    case "ofapi_webhook_silence":
      return "OFAPI webhooks delivering again";
    case "wrong_transactions_writer":
      return "Transactions writer conflict cleared";
    case "read_gateway_capture":
      return "Read-gateway capture tee healthy again";
    case "golden_signal_lag":
      return "Golden-signal lag back under threshold";
    case "scheduler_silent":
      return "Scheduler heartbeat back; cron firing again";
    case "ops_sampler_silent":
      return "Golden-signal sampler emitting again";
    case "sync_silent":
      if (input.subKey === FANSLY_SEND_GUARD_CLOSED_SUBKEY) {
        return "Fansly page open again: its request holder completed or was confirmed gone";
      }
      if (input.subKey === FANSLY_PACE_VIOLATION_SUBKEY) {
        return "No Fansly pace violation for an hour";
      }
      return "Fansly sync chunks starting again";
    case "fansly_sync_engine": {
      if (isSyncEngineRouteSubKey(input.subKey)) return SYNC_ENGINE_ROUTE_RESOLVE_DETAIL;
      const subKey = syncEngineSubKey(input.subKey);
      return subKey === null ? "Fansly Sync Engine alert cleared" : SYNC_ENGINE_RESOLVE_DETAILS[subKey];
    }
    case "ofapi_chargebacks_reconcile_failed":
      return "OFAPI chargebacks reconcile recovered";
    case "ofapi_link_stats_reconcile_failed":
      if (input.subKey === OFAPI_LINK_STATS_SERIES_STALE_SUBKEY) {
        return "OnlyFans link series is being written again";
      }
      if (input.subKey === OFAPI_LINK_STATS_PAGE_UNMAPPED_SUBKEY) {
        return "OnlyFans page is mapped to an OFAPI account again";
      }
      return "OFAPI link-stats reconcile recovered";
    case "ai_provider_billing":
      return "AI provider billing recovered";
    case "ai_provider_failed":
      if (input.subKey === AI_MEDIA_DESCRIBE_BREAKER_SUBKEY) {
        return "AI image describer resumed";
      }
      if (input.subKey === AI_MEDIA_DESCRIBE_ACCOUNT_STOP_SUBKEY) {
        return "AI image describer re-enabled by the owner";
      }
      if (input.subKey === AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY) {
        return "Fansly image fast lane retired: the Sync Engine reads a fan's new media";
      }
      return "AI provider generation recovered";
    case "capture_payload_parity":
      // THREE conditions share this kind and NOT its latch (G5 slice 3b and
      // #222, the db_disk_usage runway shape from #213): a clean parity sample
      // says nothing about whether a digest is unique again, and neither says
      // anything about whether a reference resolves. Each resolve line names the
      // condition that actually cleared, so none can be read as a catalog-wide
      // all-clear.
      if (input.subKey === "sha256_collision") {
        return "Capture payload sha256 collisions cleared (no object carries a collision ordinal); "
          + "the inline-copy parity latch is unaffected";
      }
      if (input.subKey === "dangling_reference") {
        return "Capture payload references all resolve again (none point at a missing catalog row) "
          + "in the measured window; the parity and sha256 collision latches are unaffected";
      }
      return "Capture payload copies match the inline facts again; "
        + "the sha256 collision latch is unaffected";
  }
}

/** Exported for tests (the resolve-text regression pins the per-kind lines). */
export function resolveMessageForIncident(
  input: {
    kind: NotificationIncidentKind;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    subKey?: string | null;
    /** The resolved row's `metadata.resolution` (`IncidentResolution`): a
     *  resolve that is not the condition's own recovery says why. */
    resolution?: string | null;
  },
) {
  const detail = resolveDetailForIncident(input);
  const reason = incidentResolutionReason(input.resolution);

  return [
    "✅ Resolved",
    input.pageLabel
      ? `${detail}: ${input.pageLabel}${input.platform ? ` (${input.platform})` : ""}`
      : detail,
    ...(reason === null ? [] : [`Reason: ${reason}`]),
  ].join("\n");
}

async function openIncidentAndNotify(
  app: IncidentApp,
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    subKey?: string | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    occurredAt?: Date;
    /** `policy` (default): the latch alone; the paging sweep decides whether
     * and when it pages. `critical_outbox`: the AI critical pair, whose
     * outbox row commits inside the latch transition (Decision 186). */
    deliveryMode?: "policy" | "critical_outbox";
  },
): Promise<boolean> {
  // Returns whether the latch now reflects the condition (opened, reopened,
  // refreshed, or suppressed by a newer recovery). False = the open itself
  // failed — callers with their own once-only latches (read-gateway capture)
  // re-arm on false; this function never throws, so a rejected promise can't
  // carry that signal.
  try {
    const occurredAt = input.occurredAt ?? new Date();
    const outboxMessage = input.deliveryMode === "critical_outbox"
      ? openMessageForIncident({
        ...input,
        errorSummary: input.errorSummary ?? null,
      })
      : null;
    await openNotificationIncidentWithRecoveryGuard(app.db, {
      incidentKey: incidentKey(input),
      kind: input.kind,
      platformAccountId: input.platformAccountId,
      stream: input.stream ?? null,
      errorCode: input.errorCode ?? null,
      errorSummary: sanitizeError(
        input.errorSummary || "Unknown error",
        INCIDENT_ERROR_OPTIONS,
      ).message,
      metadata: {
        pageLabel: input.pageLabel,
        platform: input.platform,
        stream: input.stream ?? null,
      },
      occurredAt,
      ...(outboxMessage
        ? {
          outbox: {
            channel: "telegram" as const,
            messageText: outboxMessage,
            pagingPolicy: "ai_critical" as const,
            maxAttempts: MAX_OPEN_DELIVERY_ATTEMPTS,
          },
        }
        : {}),
    });

    // Whatever the transition, the latch now reflects the condition. Paging
    // is not this function's job (Decision 381): the AI critical kinds
    // enqueued their outbox row inside the transition above, and every other
    // kind is evaluated by the paging sweep against its hold and flap rules.
    return true;
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      incidentKind: input.kind,
      err: error,
    }, "Notification incident open failed; continuing");
    return false;
  }
}

/**
 * Stage 13 single-writer gate: a write path attempted transactions for a page
 * whose registered writer is someone else (or unassigned). Opens immediately —
 * no failure-streak threshold; a refused write is a config/ops defect, not a
 * transient. Deduped by the incident key (kind + page) until recovery.
 */
export async function notifyWrongTransactionsWriterIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    attemptedWriter: string;
    assignedWriter: string | null;
  },
) {
  await openIncidentAndNotify(app, {
    kind: "wrong_transactions_writer",
    platformAccountId: input.platformAccountId,
    pageLabel: input.pageLabel,
    platform: input.platform,
    errorCode: "wrong_transactions_writer",
    errorSummary: `'${input.attemptedWriter}' attempted to write transactions for a page whose writer is ${
      input.assignedWriter ? `'${input.assignedWriter}'` : "unassigned"
    }`,
  });
}

async function resolveIncidentAndNotify(
  app: IncidentApp,
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    recoveredAt?: Date;
    stream?: SyncStream | null;
    subKey?: string | null;
    /** Set only when the resolve is not the condition's own recovery. */
    resolution?: IncidentResolution;
    deliveryMode?: "policy" | "critical_outbox";
  },
): Promise<boolean> {
  const recoveredAt = input.recoveredAt ?? new Date();
  const metadata = {
    pageLabel: input.pageLabel,
    platform: input.platform,
    stream: input.stream ?? null,
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
  };
  try {
    const resolved = await recoverAndResolveNotificationIncident(app.db, {
      incidentKey: incidentKey(input),
      recoveredAt,
      processedAt: recoveredAt,
      metadata,
      ...(input.deliveryMode === "critical_outbox"
        ? {
          outbox: {
            channel: "telegram" as const,
            messageText: resolveMessageForIncident(input),
            pagingPolicy: "ai_critical" as const,
            maxAttempts: MAX_OPEN_DELIVERY_ATTEMPTS,
          },
        }
        : {}),
    });

    // Decision 381: the recovery notice for every non-critical kind is the
    // paging sweep's, once the condition has stayed quiet for its hold.
    // True: this call moved an open latch to resolved.
    return resolved !== null;
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      incidentKind: input.kind,
      err: error,
    }, "Notification incident resolve failed; continuing");
    return false;
  }
}

export type CriticalNotificationIncidentKind =
  | "ai_provider_billing"
  | "ai_provider_failed";

/**
 * Stage 1A infrastructure seam, activated by Stage 1B's AI producers. The
 * incident transition and its durable Telegram outbox row commit atomically.
 * Critical paging is independent from syncFailureAlertsEnabled and defaults
 * to persisted suppression.
 */
export async function openCriticalNotificationIncident(
  app: CriticalIncidentApp,
  input: {
    kind: CriticalNotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    subKey?: string | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    occurredAt?: Date;
  },
): Promise<boolean> {
  return openIncidentAndNotify(app, {
    ...input,
    deliveryMode: "critical_outbox",
  });
}

/** Matching durable resolve seam used by Stage 1B success terminals. */
export async function resolveCriticalNotificationIncident(
  app: CriticalIncidentApp,
  input: {
    kind: CriticalNotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    subKey?: string | null;
    recoveredAt?: Date;
  },
) {
  await resolveIncidentAndNotify(app, {
    ...input,
    deliveryMode: "critical_outbox",
  });
}

async function hasTerminalProxyFailure(
  app: Pick<AppContext, "db">,
  runId: number,
) {
  return hasRecentTerminalProxyFailure(app.db, {
    runId,
    limit: 2_000,
  });
}

export async function notifySyncChunkFailureIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    stream: SyncStream;
    runId: number;
    hasProxy: boolean;
    previousConsecutiveFailures: number;
    forceOpen?: boolean;
    errorCode?: string | null;
    errorSummary: string;
    occurredAt?: Date;
  },
) {
  try {
    if (input.platform === "fansly" && (await isFanslyPageEngineOwned(app.db, input.platformAccountId)).owned) {
      // A legacy chunk failure reported for a page the Fansly Sync Engine
      // owns: the legacy stream no longer runs, so its failure is not the
      // page's state — the engine reports the page through its own alerts —
      // and a stream latch opened now would wait for a legacy recovery that
      // never comes (the transition closed it, `engine_owned`).
      app.logger.warn({
        platformAccountId: input.platformAccountId,
        stream: input.stream,
        errorCode: input.errorCode ?? null,
      }, "Legacy stream failure on a page the Fansly Sync Engine owns; no legacy incident opened");
      return;
    }
    if (input.hasProxy && await hasTerminalProxyFailure(app, input.runId)) {
      await openIncidentAndNotify(app, {
        ...input,
        kind: "proxy_failed",
      });
      return;
    }

    // W3.3 (A36): `<`, not exact equality — after a manual resolve mid-streak
    // the count never equals the threshold again, so exact-match meant no
    // re-alert ever. At-or-above keeps hitting the open path: dedupe handles
    // the standing case, the `reopened` transition restores post-resolve
    // alerting, and the D3-N1 retry covers a lost open send.
    if (!input.forceOpen && (input.previousConsecutiveFailures + 1) < STREAM_FAILURE_THRESHOLD) {
      return;
    }

    await openIncidentAndNotify(app, {
      ...input,
      kind: "stream_failed_threshold",
    });
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      stream: input.stream,
      err: error,
    }, "Sync chunk failure notification evaluation failed; continuing");
  }
}

export async function resolveSyncChunkRecoveryIncidents(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    recoveredAt?: Date;
    /** When the provider last answered successfully: the chunk's newest
     * successful response. Null when the chunk has no such evidence (zero
     * requests, every attempt failed, or a settlement retry reusing an earlier
     * result): page-wide auth/proxy incidents then stay open and get no
     * tombstone. */
    providerRecoveredAt: Date | null;
    stream: SyncStream;
  },
) {
  const recoveredAt = input.recoveredAt ?? new Date();
  if (input.providerRecoveredAt !== null) {
    await resolveIncidentAndNotify(app, {
      ...input,
      kind: "auth_blocked",
      recoveredAt: input.providerRecoveredAt,
    });
    await resolveIncidentAndNotify(app, {
      ...input,
      kind: "proxy_failed",
      recoveredAt: input.providerRecoveredAt,
    });
  }
  // W3.1: a successful chunk implies the page context resolved, which the
  // fail-closed guard only allows with a proxy present.
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "proxy_missing",
    recoveredAt,
  });
  // The stream's own alert follows its failure streak, which this chunk's
  // completion or yield has just reset.
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "stream_failed_threshold",
    recoveredAt,
  });
}

/**
 * The transition of a Fansly page to the Fansly Sync Engine: a legacy
 * stream's latch (`stream_failed_threshold:<page>:<stream>`) resolves only
 * through the legacy executor's chunk recovery above, and the legacy executor
 * never runs a stream of a page the engine runs live — such a latch would stay
 * open for ever (production incident 41, lilly-2 `dm_conversations`, opened
 * by the legacy engine the day before its switch). Every live takeover of the
 * engine host closes the page's open ones here, through the ordinary resolve
 * (the recovery tombstone; the paging sweep's resolve message, which names
 * the reason `engine_owned`).
 *
 * Only a page in `live`: the engine runs no other. Idempotent:
 * with none open nothing is written. The engine's own latches
 * (`fansly_sync_engine`) and every other kind stay as they are; an OnlyFans
 * page has no `sync_pages` row, so it is never live. The legacy executor
 * cannot open them again while the engine owns the page
 * (`notifySyncChunkFailureIncident`). Never throws; returns the streams whose
 * latch this call resolved.
 */
export async function resolveLegacyStreamIncidentsOfEnginePage(
  app: IncidentApp,
  input: { pageId: number; pageLabel: string | null; recoveredAt?: Date },
): Promise<SyncStream[]> {
  try {
    if ((await isFanslyPageEngineOwned(app.db, input.pageId)).mode !== "live") return [];
    const open = await listNotificationIncidents(app.db, { status: "open", platformAccountId: input.pageId });
    const recoveredAt = input.recoveredAt ?? new Date();
    const closed: SyncStream[] = [];
    for (const incident of open) {
      if (incident.kind !== "stream_failed_threshold" || incident.stream === null) continue;
      const stream = incident.stream;
      // Only the latch shape the legacy executor keys.
      if (incident.incidentKey !== incidentKey({ kind: "stream_failed_threshold", platformAccountId: input.pageId, stream })) continue;
      const resolved = await resolveIncidentAndNotify(app, {
        kind: "stream_failed_threshold",
        platformAccountId: input.pageId,
        pageLabel: input.pageLabel,
        platform: "fansly",
        stream,
        recoveredAt,
        resolution: "engine_owned",
      });
      if (resolved) closed.push(stream);
    }
    return closed;
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.pageId,
      err: error,
    }, "Legacy stream incidents of an engine page could not be read; they stay open until the next live takeover");
    return [];
  }
}

/**
 * W3.1 (B6+A35, decision #124): the fail-closed egress guard refused to
 * resolve a Fansly page context because no proxy is stored. Opens
 * immediately — a missing proxy is a config/erasure aftermath, not a
 * transient. Deduped by kind+page until a proxy is assigned and the page
 * verifies or syncs again.
 */
export async function notifyProxyMissingIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    errorSummary: string;
    occurredAt?: Date;
  },
) {
  await openIncidentAndNotify(app, {
    kind: "proxy_missing",
    platformAccountId: input.platformAccountId,
    pageLabel: input.pageLabel,
    platform: "fansly",
    errorCode: "proxy_missing",
    errorSummary: input.errorSummary,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

/** Debounced alert for OFAPI accounts.* auth states (decision #49, Phase 3). */
export async function notifyOfapiAuthIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    authStatus: string;
    occurredAt?: Date;
  },
) {
  await openIncidentAndNotify(app, {
    kind: "ofapi_auth",
    platformAccountId: input.platformAccountId,
    pageLabel: input.pageLabel,
    platform: input.platform,
    errorCode: input.authStatus,
    errorSummary: `OFAPI reported accounts.${input.authStatus}`,
    occurredAt: input.occurredAt,
  });
}

export async function resolveOfapiAuthIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    recoveredAt?: Date;
  },
) {
  await resolveIncidentAndNotify(app, {
    kind: "ofapi_auth",
    platformAccountId: input.platformAccountId,
    pageLabel: input.pageLabel,
    platform: input.platform,
    recoveredAt: input.recoveredAt,
  });
}

/**
 * Plan §2.5/§10: the page's send guard is closed — the holder of its last
 * request overran its lease and is neither completed nor confirmed gone, so
 * nothing is sent for the page. The summary names the holder and what to run.
 */
export async function notifyFanslySendGuardClosedIncident(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    pageId: number;
    pageLabel: string | null;
    errorSummary: string;
    occurredAt: Date;
  },
): Promise<boolean> {
  return openIncidentAndNotify(app, {
    kind: "sync_silent",
    platformAccountId: input.pageId,
    pageLabel: input.pageLabel,
    platform: "fansly",
    subKey: FANSLY_SEND_GUARD_CLOSED_SUBKEY,
    errorCode: "send_guard_closed",
    errorSummary: input.errorSummary,
    occurredAt: input.occurredAt,
  });
}

/** The page's send guard is open again. */
export async function resolveFanslySendGuardClosedIncident(
  app: Pick<AppContext, "db" | "logger">,
  input: { pageId: number; pageLabel: string | null; recoveredAt: Date },
) {
  await resolveIncidentAndNotify(app, {
    kind: "sync_silent",
    platformAccountId: input.pageId,
    pageLabel: input.pageLabel,
    platform: "fansly",
    subKey: FANSLY_SEND_GUARD_CLOSED_SUBKEY,
    recoveredAt: input.recoveredAt,
  });
}

/** Plan §2.4/§10: two sends of the page closer than the setting in force for
 *  the later one (journal `sent_at`, all sources). */
export async function notifyFanslyPaceViolationIncident(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    pageId: number;
    pageLabel: string | null;
    errorSummary: string;
    occurredAt: Date;
  },
): Promise<boolean> {
  return openIncidentAndNotify(app, {
    kind: "sync_silent",
    platformAccountId: input.pageId,
    pageLabel: input.pageLabel,
    platform: "fansly",
    subKey: FANSLY_PACE_VIOLATION_SUBKEY,
    errorCode: "pace_violation",
    errorSummary: input.errorSummary,
    occurredAt: input.occurredAt,
  });
}

export async function resolveFanslyPaceViolationIncident(
  app: Pick<AppContext, "db" | "logger">,
  input: { pageId: number; pageLabel: string | null; recoveredAt: Date },
) {
  await resolveIncidentAndNotify(app, {
    kind: "sync_silent",
    platformAccountId: input.pageId,
    pageLabel: input.pageLabel,
    platform: "fansly",
    subKey: FANSLY_PACE_VIOLATION_SUBKEY,
    recoveredAt: input.recoveredAt,
  });
}

/**
 * Plan §10, design §9.6: open one of the engine's alerts. Page alerts (1–4)
 * name the page; alert 5 is global (`pageId` null). `occurredAt` is the
 * condition's own instant (a pace violation's send): an occurrence older than
 * the owner's acknowledgement is suppressed by the latch's recovery guard.
 */
export async function notifySyncEngineIncident(
  app: IncidentApp,
  input: {
    subKey: SyncEngineIncidentSubKey;
    pageId: number | null;
    pageLabel: string | null;
    /** The condition, from the closed per-alert vocabulary (`rate_limit`, `handover_stuck`, …). */
    detail: string;
    errorSummary: string;
    occurredAt: Date;
  },
): Promise<boolean> {
  return openIncidentAndNotify(app, {
    kind: "fansly_sync_engine",
    platformAccountId: input.pageId,
    pageLabel: input.pageLabel,
    platform: input.pageId === null ? null : "fansly",
    subKey: input.subKey,
    errorCode: input.detail,
    errorSummary: input.errorSummary,
    occurredAt: input.occurredAt,
  });
}

export async function resolveSyncEngineIncident(
  app: IncidentApp,
  input: { subKey: SyncEngineIncidentSubKey; pageId: number | null; pageLabel: string | null; recoveredAt: Date },
) {
  await resolveIncidentAndNotify(app, {
    kind: "fansly_sync_engine",
    platformAccountId: input.pageId,
    pageLabel: input.pageLabel,
    platform: input.pageId === null ? null : "fansly",
    subKey: input.subKey,
    recoveredAt: input.recoveredAt,
  });
}

/** The latch key of one engine alert (what `sync alerts` reads back). */
export function syncEngineIncidentKey(input: { subKey: SyncEngineIncidentSubKey; pageId: number | null }): string {
  return incidentKey({ kind: "fansly_sync_engine", platformAccountId: input.pageId, subKey: input.subKey });
}

type GlobalIncidentKind =
  | "ofapi_binding_conflict"
  | "ofapi_low_credit"
  | "ofapi_webhook_silence"
  | "ofapi_burn_rate"
  | "db_disk_usage"
  | "observations_partitions"
  | "read_gateway_capture"
  | "golden_signal_lag"
  | "scheduler_silent"
  | "ops_sampler_silent"
  | "sync_silent"
  | "ofapi_chargebacks_reconcile_failed"
  | "ofapi_link_stats_reconcile_failed"
  | "capture_payload_parity";

/** Process-global conditions (low credit balance, webhook silence, burn rate,
 * disk usage, partition lead, watchdog deadmen). W5.1 (A25): `subKey` splits
 * the latch per condition within a kind (golden_signal_lag per metric). */
export async function notifyOfapiGlobalIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    kind: GlobalIncidentKind;
    errorSummary: string;
    subKey?: string | null;
    occurredAt?: Date;
  },
): Promise<boolean> {
  return openIncidentAndNotify(app, {
    kind: input.kind,
    platformAccountId: null,
    pageLabel: null,
    platform: null,
    subKey: input.subKey ?? null,
    errorSummary: input.errorSummary,
    occurredAt: input.occurredAt,
  });
}

export async function resolveOfapiGlobalIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    kind: GlobalIncidentKind;
    subKey?: string | null;
    recoveredAt?: Date;
  },
) {
  await resolveIncidentAndNotify(app, {
    kind: input.kind,
    platformAccountId: null,
    pageLabel: null,
    platform: null,
    subKey: input.subKey ?? null,
    recoveredAt: input.recoveredAt,
  });
}

/** Open a page latch of the OnlyFans link series (the minutely series monitor
 * is the one caller). Like every non-critical kind it only moves the latch:
 * whether and when it pages is the paging policy's — `series_stale` at once,
 * `page_unmapped` after 30 minutes. */
export async function notifyOfapiLinkStatsPageIncident(
  app: IncidentApp,
  input: {
    subKey: OfapiLinkStatsPageSubKey;
    pageId: number;
    pageLabel: string;
    errorSummary: string;
    occurredAt: Date;
  },
): Promise<boolean> {
  return openIncidentAndNotify(app, {
    kind: "ofapi_link_stats_reconcile_failed",
    platformAccountId: input.pageId,
    pageLabel: input.pageLabel,
    platform: "onlyfans",
    subKey: input.subKey,
    errorCode: input.subKey,
    errorSummary: input.errorSummary,
    occurredAt: input.occurredAt,
  });
}

export async function resolveOfapiLinkStatsPageIncident(
  app: IncidentApp,
  input: { subKey: OfapiLinkStatsPageSubKey; pageId: number; pageLabel: string; recoveredAt: Date },
): Promise<boolean> {
  return resolveIncidentAndNotify(app, {
    kind: "ofapi_link_stats_reconcile_failed",
    platformAccountId: input.pageId,
    pageLabel: input.pageLabel,
    platform: "onlyfans",
    subKey: input.subKey,
    recoveredAt: input.recoveredAt,
  });
}

/** The latch key of one page's link-series incident. */
export function ofapiLinkStatsPageIncidentKey(input: { subKey: OfapiLinkStatsPageSubKey; pageId: number }): string {
  return incidentKey({
    kind: "ofapi_link_stats_reconcile_failed",
    platformAccountId: input.pageId,
    subKey: input.subKey,
  });
}

/**
 * A Fansly page's credentials verified — the engine's `account.verify`, or its
 * identity check of a credentials or proxy change that was then stored: the
 * page's verification incidents resolve. Nothing else is touched: an engine
 * hold clears by the engine's own proof (A3), and the legacy executor, whose
 * auth block this used to lift, serves no Fansly page (step 4).
 */
export async function handleSuccessfulPageVerificationRecovery(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    recoveredAt?: Date;
  },
): Promise<void> {
  const recoveredAt = input.recoveredAt ?? new Date();
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "auth_blocked",
    recoveredAt,
  });
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "proxy_failed",
    recoveredAt,
  });
  // W3.1: a successful verification reached Fansly, which the fail-closed
  // dispatcher only allows with a proxy present.
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "proxy_missing",
    recoveredAt,
  });
}
