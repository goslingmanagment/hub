import type {
  NotificationIncidentKind,
  NotificationIncidentStatus,
  NotificationPagingMode,
} from "@agency_hub_core/db";

// Decision 381: the paging policy that sits between an incident latch and the
// owner's Telegram. The latch answers "is the condition true right now"; this
// module answers "is it worth a message yet", and it is pure so the whole
// decision table is unit-tested without a database.
//
// Three rules, per kind:
//   openHoldMs     — the condition must stay open this long before it pages
//                    (0 = page on the first sweep that sees it open);
//   recoveryHoldMs — it must stay resolved this long before the recovery is
//                    announced; a reopen inside the hold is the SAME incident
//                    and produces no message at all;
//   flap           — a condition that opened this many times inside the window
//                    pages as "flapping" even if no single episode outlasts
//                    the open hold, because a proxy that fails every ten
//                    minutes for a minute is broken and would otherwise never
//                    page.

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export interface NotificationPagingPolicy {
  openHoldMs: number;
  recoveryHoldMs: number;
  flap: { episodes: number; windowMs: number } | null;
}

const DEFAULT_FLAP = { episodes: 5, windowMs: 6 * HOUR_MS } as const;
/** The watchdog deadmen open on every deploy: production had 12 such
 * episodes on 2026-09-22..29, up to three inside six hours, so the default
 * rule would page "flapping" on the fifth deploy of a busy afternoon. A
 * process that really dies stays down past the open hold and pages as
 * sustained; this only keeps a backstop for one that keeps dropping out. */
const DEPLOY_TOLERANT_FLAP = { episodes: 12, windowMs: 6 * HOUR_MS } as const;

function immediate(recoveryHoldMs = 5 * MINUTE_MS): NotificationPagingPolicy {
  return { openHoldMs: 0, recoveryHoldMs, flap: null };
}

function sustained(
  openHoldMs: number,
  recoveryHoldMs: number,
  flap: NotificationPagingPolicy["flap"] = DEFAULT_FLAP,
): NotificationPagingPolicy {
  return { openHoldMs, recoveryHoldMs, flap };
}

/** Kinds that page through their own atomic outbox at transition time
 * (Decision 186) and are never evaluated by this policy. */
export const NOTIFICATION_PAGING_EXCLUDED_KINDS = [
  "ai_provider_billing",
  "ai_provider_failed",
] as const satisfies readonly NotificationIncidentKind[];

/**
 * Exhaustive over the kind union: a new kind without a row here is a compile
 * error, not a silently-immediate page.
 */
export const NOTIFICATION_PAGING_POLICY_BY_KIND: Record<
  NotificationIncidentKind,
  NotificationPagingPolicy
> = {
  // Conditions that do not heal on their own and need a hand today.
  auth_blocked: immediate(),
  proxy_missing: immediate(),
  ofapi_auth: immediate(),
  ofapi_binding_conflict: immediate(),
  wrong_transactions_writer: immediate(),
  ofapi_low_credit: immediate(15 * MINUTE_MS),
  observations_partitions: immediate(15 * MINUTE_MS),
  read_gateway_capture: immediate(15 * MINUTE_MS),
  capture_payload_parity: immediate(15 * MINUTE_MS),
  ofapi_chargebacks_reconcile_failed: immediate(HOUR_MS),
  // Percent and runway_critical; runway_warning is overridden below.
  db_disk_usage: immediate(HOUR_MS),

  // Conditions that flap on transient causes: a proxy hiccup, a retried
  // chunk, a deploy's restart gap. Measured on production 2026-09-15..21:
  // three quarters of proxy_failed episodes healed inside five minutes and
  // every scheduler_silent episode was a deploy (~5 min). The holds sit
  // above those, the flap rule catches the proxy that hiccups all day.
  proxy_failed: sustained(15 * MINUTE_MS, 30 * MINUTE_MS),
  stream_failed_threshold: sustained(10 * MINUTE_MS, 30 * MINUTE_MS),
  scheduler_silent: sustained(10 * MINUTE_MS, 10 * MINUTE_MS, DEPLOY_TOLERANT_FLAP),
  ops_sampler_silent: sustained(10 * MINUTE_MS, 10 * MINUTE_MS, DEPLOY_TOLERANT_FLAP),
  // The kind's own latch (no sub-key) was the ops watchdog's legacy Fansly
  // sync deadman: no chunk started for 15 min while a stream was due. Nothing
  // opens it since step 4 (S4-21: no Fansly page has a legacy stream); the
  // policy stays for a latch an older build left open. No flap rule: a thin
  // fleet ran 15-16.6 min between chunks, so the latch flickered while chunks
  // kept starting; a real stall outlasted the hold and paged as sustained.
  sync_silent: sustained(10 * MINUTE_MS, 10 * MINUTE_MS, null),
  // The Fansly Sync Engine (design §9.6): every alert pages at once — its
  // conditions already carry their own delays (a 429 is never transient for
  // the pace rule; a socket counts after 5 min down, urgent work after 2 min,
  // a silent process after 2 min) and alert 1 resolves only after 10 clean
  // minutes. Shadow pages never open one (D14).
  fansly_sync_engine: immediate(),
  golden_signal_lag: sustained(30 * MINUTE_MS, HOUR_MS),
  ofapi_burn_rate: sustained(30 * MINUTE_MS, HOUR_MS),
  ofapi_webhook_silence: sustained(10 * MINUTE_MS, 30 * MINUTE_MS),
  // The kind's own latch (no sub-key, global) is ONE failed pass of the
  // OnlyFans link series. The pass is retried inside its window and read
  // again at the next one, the reads are free, and a series that really
  // stopped pages through its own latch (`series_stale`, below) — so a failed
  // pass is a line in the daily digest, and a message only if nothing has
  // closed it for 30 hours. No flap rule: one that fails and recovers every
  // window is exactly the case the retries exist for.
  ofapi_link_stats_reconcile_failed: sustained(30 * HOUR_MS, HOUR_MS, null),

  // Excluded from the sweep (see NOTIFICATION_PAGING_EXCLUDED_KINDS); rows
  // exist only so the record stays exhaustive.
  ai_provider_billing: immediate(),
  ai_provider_failed: immediate(),
};

export function notificationPagingPolicyFor(
  kind: NotificationIncidentKind,
  subKey: string | null,
): NotificationPagingPolicy {
  // Plan §2.5/§10: the Fansly send guard's page latches page at once — a
  // closed page sends nothing, and a pace violation must never happen. Their
  // kind's default (a 10-minute hold) was the legacy sync deadman's.
  if (kind === "sync_silent" && subKey === "send_guard_closed") {
    return immediate(5 * MINUTE_MS);
  }
  if (kind === "sync_silent" && subKey === "pace_violation") {
    return immediate(15 * MINUTE_MS);
  }
  // Traffic sources plan §2.10: the link series' page latches.
  if (kind === "ofapi_link_stats_reconcile_failed" && subKey === "series_stale") {
    // Two windows and more without a usable result for a page: the condition
    // already carries its own delay (two intervals plus the retries), so it
    // pages on the sweep that sees it.
    return immediate(HOUR_MS);
  }
  if (kind === "ofapi_link_stats_reconcile_failed" && subKey === "page_unmapped") {
    // The binding reconciler repairs a lost mapping within five minutes; a
    // page still unmapped after thirty needs a hand.
    return sustained(30 * MINUTE_MS, 5 * MINUTE_MS, null);
  }
  if (kind === "db_disk_usage" && subKey === "runway_warning") {
    // A 30-day runway that hovers at 29 days flips hourly; the warning is
    // useful once, and its all-clear is only news after a full day.
    return { openHoldMs: 6 * HOUR_MS, recoveryHoldMs: 24 * HOUR_MS, flap: null };
  }
  return NOTIFICATION_PAGING_POLICY_BY_KIND[kind];
}

export interface NotificationPagingObservation {
  status: NotificationIncidentStatus;
  /** The latch's newest episode start. */
  openedAt: Date;
  resolvedAt: Date | null;
  paging: {
    pagedAt: Date | null;
    pagedOpenedAt: Date | null;
    pagedMode: NotificationPagingMode | null;
    pagedResolvedAt: Date | null;
  } | null;
  /** Episodes (including the current one) that started inside the flap window. */
  episodesInWindow: number;
  earliestEpisodeInWindowAt: Date | null;
  /** The dashboard already sent "Manually resolved" for the standing page. */
  manuallyResolvedSincePage: boolean;
}

export type NotificationPagingDecision =
  | { action: "none" }
  | {
    action: "page";
    mode: NotificationPagingMode;
    transition: "opened" | "reopened";
    /** Identifies the outbox row; the episode start for held pages, the
     * decision instant for a flapping page. */
    transitionAt: Date;
    /** The episode start the page covers, for "was open for …" later. */
    coveredOpenedAt: Date;
  }
  | {
    action: "resolve";
    transitionAt: Date;
    /** True when the recovery must be recorded but not announced. */
    silent: boolean;
  };

export function decideNotificationPaging(
  input: NotificationPagingObservation,
  policy: NotificationPagingPolicy,
  now: Date,
): NotificationPagingDecision {
  const standing = input.paging?.pagedAt !== null
    && input.paging?.pagedAt !== undefined
    && input.paging.pagedResolvedAt === null;

  if (standing) {
    if (input.status === "open" || !input.resolvedAt) {
      // Still broken, or broke again inside the recovery hold: same incident.
      return { action: "none" };
    }
    if (input.manuallyResolvedSincePage) {
      return { action: "resolve", transitionAt: input.resolvedAt, silent: true };
    }
    if (now.getTime() - input.resolvedAt.getTime() >= policy.recoveryHoldMs) {
      return { action: "resolve", transitionAt: input.resolvedAt, silent: false };
    }
    return { action: "none" };
  }

  const transition = input.paging?.pagedAt ? "reopened" : "opened";
  if (input.status === "open") {
    if (policy.openHoldMs === 0) {
      return {
        action: "page",
        mode: "immediate",
        transition,
        transitionAt: input.openedAt,
        coveredOpenedAt: input.openedAt,
      };
    }
    if (now.getTime() - input.openedAt.getTime() >= policy.openHoldMs) {
      return {
        action: "page",
        mode: "sustained",
        transition,
        transitionAt: input.openedAt,
        coveredOpenedAt: input.openedAt,
      };
    }
  }
  if (policy.flap && input.episodesInWindow >= policy.flap.episodes) {
    return {
      action: "page",
      mode: "flapping",
      transition,
      transitionAt: now,
      coveredOpenedAt: input.earliestEpisodeInWindowAt ?? input.openedAt,
    };
  }
  return { action: "none" };
}

/** "45 s", "16 min", "1 h 12 min", "3 d 4 h" — for the owner's eye, not a log. */
export function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / SECOND_MS));
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0 ? `${totalHours} h ${minutes} min` : `${totalHours} h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
}
