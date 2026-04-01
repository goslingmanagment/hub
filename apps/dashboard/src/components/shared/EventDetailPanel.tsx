import { Link } from "react-router";

export const SEVERITY_STYLES: Record<string, string> = {
  info: "bg-[#e5e7eb] text-[#374151]",
  warn: "bg-[#fef3c7] text-[#92400e]",
  error: "bg-[#fee2e2] text-[#991b1b]",
};

function isLegacyBenignAfterFilterAnomaly(input: {
  eventCode?: string | null;
  severity: string;
  details?: Record<string, unknown> | null;
}) {
  return input.eventCode === "after_ineffective" &&
    input.severity === "error" &&
    input.details?.earlyStoppedBeyondBoundary === true;
}

export function getEventDisplaySeverity(input: {
  eventCode?: string | null;
  severity: string;
  details?: Record<string, unknown> | null;
}) {
  return isLegacyBenignAfterFilterAnomaly(input) ? "warn" : input.severity;
}

const RECOMMENDATION_MAP: Record<string, { text: string; color: string }> = {
  checkpoint_stalled: {
    text: "Page has no new data since last sync. Usually means the page is inactive. No action needed.",
    color: "border-[#9ca3af]",
  },
  after_ineffective: {
    text: "The provider ignored the lower-bound filter and older transactions were rescanned. Sync handled it automatically; investigate only if the scan window keeps growing.",
    color: "border-[#f59e0b]",
  },
  auth_blocked: {
    text: "Session token expired or invalid. Update credentials in page settings.",
    color: "border-[#ef4444]",
  },
  anomaly: {
    text: "Follower count from API doesn't match local data. A reconciliation sync has been triggered automatically.",
    color: "border-[#f59e0b]",
  },
  follower_count_mismatch: {
    text: "Follower count from API doesn't match local data. A reconciliation sync has been triggered automatically.",
    color: "border-[#f59e0b]",
  },
  rate_limited: {
    text: "Platform API rate limit hit. Sync will retry automatically on next cycle.",
    color: "border-[#f59e0b]",
  },
  timeout: {
    text: "API request timed out. Usually a temporary platform issue. Will retry.",
    color: "border-[#f59e0b]",
  },
};

const DEFAULT_RECOMMENDATION = {
  text: "No automated recommendation. Check details below.",
  color: "border-[#9ca3af]",
};

export function getEventRecommendation(eventCode?: string | null) {
  return (eventCode ? RECOMMENDATION_MAP[eventCode] : undefined) ?? DEFAULT_RECOMMENDATION;
}

interface EventDetailPanelProps {
  message?: string | null;
  syncRunId?: number | string | null;
  eventCode?: string | null;
  severity: string;
  details?: Record<string, unknown> | null;
}

export function EventDetailPanel({
  message,
  syncRunId,
  eventCode,
  details,
}: EventDetailPanelProps) {
  const rec = getEventRecommendation(eventCode);

  return (
    <div className="px-6 py-4 bg-hover-alt/40 space-y-3">
      {/* Full message */}
      {message && (
        <p className="text-sm text-text-primary whitespace-pre-wrap">{message}</p>
      )}

      {/* Sync run link */}
      {syncRunId != null && (
        <Link
          to={`/dev/sync-status?runId=${syncRunId}`}
          className="inline-block text-sm text-accent hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          View sync run →
        </Link>
      )}

      {/* Recommendation banner */}
      <div className={`border-l-4 ${rec.color} bg-bg rounded-r-lg px-4 py-2`}>
        <p className="text-sm text-text-secondary">{rec.text}</p>
      </div>

      {/* Raw details */}
      {details && Object.keys(details).length > 0 ? (
        <pre className="text-xs text-text-muted bg-bg rounded-lg p-3 overflow-x-auto">
          {JSON.stringify(details, null, 2)}
        </pre>
      ) : (
        <p className="text-xs text-text-muted">No additional details.</p>
      )}
    </div>
  );
}
