import { Link } from "react-router";
import { Notice } from "@/components/ui/Notice";

// A sync event as the System screens show it (the log, the sync anomalies):
// its severity as a badge, and the row's detail — the message, the run it
// belongs to, what to do about it, and its raw data.

const SEVERITY_BADGES: Record<string, string> = {
  info: "badge badge-bare badge-info",
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

/** `off`: the log froze with the OnlyFans API; nothing in it is red any more. */
export function SeverityBadge({ severity, off = false }: { severity: string; off?: boolean }) {
  return (
    <span className={off ? "badge badge-off" : SEVERITY_BADGES[severity] ?? SEVERITY_BADGES.info} data-severity={severity}>
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
    text: "Сессия истекла или недействительна.",
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

const RECOMMENDATION_NOTICE: Record<RecommendationTone, "info" | "warning" | "danger"> = {
  neutral: "info",
  warning: "warning",
  danger: "danger",
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
  off = false,
}: EventDetailPanelProps & { off?: boolean }) {
  const rec = getEventRecommendation(eventCode);

  return (
    // Sticky at the table's left edge: the table scrolls sideways, its detail stays in view.
    <div className="sys-event-detail">
      {message && <p className="sys-event-message">{message}</p>}
      <Notice tone={off ? "info" : RECOMMENDATION_NOTICE[rec.tone]}>{rec.text}</Notice>
      {syncRunId != null && (
        <Link to={`/system/dev/log/${syncRunId}`} className="link sys-align-start" onClick={(e) => e.stopPropagation()}>
          Открыть запуск сбора
        </Link>
      )}
      {details && Object.keys(details).length > 0 ? (
        <div>
          <p className="sys-label">Данные события</p>
          <pre className="sys-json">{JSON.stringify(details, null, 2)}</pre>
        </div>
      ) : (
        <p className="cell-second">Других данных нет.</p>
      )}
    </div>
  );
}
