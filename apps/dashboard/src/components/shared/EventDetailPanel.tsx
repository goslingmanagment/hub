import { Link } from "react-router";

// A sync event as the System screens show it (the log, the sync anomalies):
// its severity as a badge, and the row's detail — the message, the run it
// belongs to, what to do about it, and its raw data.

const SEVERITY_BADGES: Record<string, string> = {
  info: "badge",
  warn: "badge badge-warning",
  error: "badge badge-danger",
};

const SEVERITY_LABELS: Record<string, string> = {
  info: "Инфо",
  warn: "Предупреждение",
  error: "Ошибка",
};

export function severityLabel(severity: string): string {
  return SEVERITY_LABELS[severity] ?? severity;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={SEVERITY_BADGES[severity] ?? SEVERITY_BADGES.info} data-severity={severity}>
      {severityLabel(severity)}
    </span>
  );
}

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

type RecommendationTone = "neutral" | "warning" | "danger";

const RECOMMENDATION_MAP: Record<string, { text: string; tone: RecommendationTone }> = {
  checkpoint_stalled: {
    text: "Новых данных со времени прошлого сбора нет. Обычно это значит, что страница неактивна. Ничего делать не нужно.",
    tone: "neutral",
  },
  after_ineffective: {
    text: "Источник проигнорировал нижнюю границу фильтра, и старые операции просмотрены заново. Сбор справился сам; разбирайтесь, только если окно просмотра продолжает расти.",
    tone: "warning",
  },
  auth_blocked: {
    text: "Сессия истекла или недействительна. Обновите данные входа в настройках страницы.",
    tone: "danger",
  },
  anomaly: {
    text: "Число фолловеров от платформы не совпадает с данными Hub. Сверка запущена автоматически.",
    tone: "warning",
  },
  follower_count_mismatch: {
    text: "Число фолловеров от платформы не совпадает с данными Hub. Сверка запущена автоматически.",
    tone: "warning",
  },
  rate_limited: {
    text: "Платформа ограничила частоту запросов. Сбор повторит попытку в следующем цикле.",
    tone: "warning",
  },
  timeout: {
    text: "Платформа не ответила вовремя. Обычно это временный сбой: попытка повторится.",
    tone: "warning",
  },
};

const DEFAULT_RECOMMENDATION = {
  text: "Готовой рекомендации нет — смотрите данные события ниже.",
  tone: "neutral" as RecommendationTone,
};

const RECOMMENDATION_NOTICE: Record<RecommendationTone, string> = {
  neutral: "notice",
  warning: "notice notice-warning",
  danger: "notice notice-danger",
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
    // Sticky at the table's left edge and no wider than the phone's screen:
    // the table scrolls sideways, its detail stays in view.
    <div className="sticky left-0 max-w-[calc(100vw-50px)] space-y-3 bg-hover-alt px-4 py-4 sm:px-6 lg:max-w-none">
      {message && (
        <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{message}</p>
      )}

      <p className={`${RECOMMENDATION_NOTICE[rec.tone]} block whitespace-normal`}>{rec.text}</p>

      {syncRunId != null && (
        <Link
          to={`/dev/sync-status?runId=${syncRunId}`}
          className="link inline-block text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          Открыть запуск синка &rarr;
        </Link>
      )}

      {details && Object.keys(details).length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-medium text-text-secondary">Данные события</p>
          <pre className="overflow-x-auto rounded-lg border border-border-light bg-card p-3 font-mono text-xs text-text-secondary">
            {JSON.stringify(details, null, 2)}
          </pre>
        </div>
      ) : (
        <p className="text-xs text-text-muted">Других данных нет.</p>
      )}
    </div>
  );
}
