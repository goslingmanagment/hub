import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";

import type { CoverageVerdict } from "./coverage.js";

/** Neutral for "nobody knows yet" and "not started"; warning for every state
 *  that says the data on screen is less than the window asked for. */
const BADGE_CLASS: Readonly<Record<CoverageVerdict["state"], string>> = {
  complete: "badge",
  partial: "badge badge-warning",
  stale: "badge badge-warning",
  not_started: "badge",
  unknown: "badge badge-warning",
  pending: "badge",
  unavailable: "badge badge-warning",
  refresh_failed: "badge badge-warning",
};

/** A table that runs to the card's edges and scrolls inside it. */
export const ANALYTICS_TABLE_WRAP = "overflow-x-auto rounded-b-[11px]";

/**
 * The badge that makes partial data impossible to mistake for complete data.
 *
 * It is rendered for every state EXCEPT `complete`, and a chart with no badge is
 * therefore a chart asserting its window is fully captured. Making the honest
 * case the loud one is deliberate: the failure this whole initiative exists to
 * prevent is a confident chart drawn over a hole. The reason is its tooltip.
 */
export function CoverageBadge({ verdict }: { verdict: CoverageVerdict }) {
  if (verdict.state === "complete") {
    return null;
  }
  return (
    <span title={verdict.detail} className={BADGE_CLASS[verdict.state]}>
      {verdict.label}
    </span>
  );
}

/** The panel's OWN data is the last successful response: its refresh failed. */
export function CachedBadge() {
  return (
    <span
      title="Обновить эти данные не удалось. Показан последний успешный ответ."
      className="badge badge-warning"
    >
      Не удалось обновить
    </span>
  );
}

/**
 * The "?" beside a panel's title: how its numbers are counted. The text lives
 * here rather than under the chart, so a panel reads as a chart, not as a
 * methodology note. It opens on click or Enter, closes on Escape or a click
 * outside, and is placed against the card's header so it never leaves the card.
 */
export function InfoTip({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    function close(focusSummary: boolean) {
      const element = ref.current;
      if (element === null) return;
      element.open = false;
      if (focusSummary) element.querySelector("summary")?.focus();
    }
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close(true);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = `Как считается: ${title}`;
  return (
    <details ref={ref} className="shrink-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        aria-label={label}
        title={label}
        className="flex h-6 w-6 cursor-pointer list-none items-center justify-center rounded-full text-text-muted transition-colors hover:bg-hover hover:text-text-primary [&::-webkit-details-marker]:hidden"
      >
        <CircleHelp size={16} aria-hidden="true" />
      </summary>
      <div
        role="note"
        className="absolute inset-x-4 top-[calc(100%-6px)] z-30 max-w-[460px] space-y-2 rounded-[10px] border border-border bg-card p-3.5 text-[13px] leading-5 text-text-secondary shadow-lg"
      >
        {children}
      </div>
    </details>
  );
}

/**
 * One panel of the Analytics page: a card whose header carries the title, how
 * its numbers are counted (the "?"), and its own coverage verdict — beside the
 * title, where it cannot be scrolled past.
 */
export function AnalyticsPanel({
  title,
  description,
  verdict,
  headerExtra,
  help,
  cached = false,
  wide = false,
  children,
}: {
  title: string;
  /** One line under the title, only when it adds information. */
  description?: string | undefined;
  verdict?: CoverageVerdict | undefined;
  headerExtra?: ReactNode;
  /** How the panel counts — shown behind the "?" beside the title. */
  help?: ReactNode;
  /** True when this panel's own data is cached and its refresh failed. */
  cached?: boolean | undefined;
  /** Spans both columns of the page's grid. */
  wide?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <section className={`card flex flex-col${wide ? " xl:col-span-2" : ""}`}>
      <header className="card-header relative">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="card-title">{title}</h2>
            {help ? <InfoTip title={title}>{help}</InfoTip> : null}
            {verdict ? <CoverageBadge verdict={verdict} /> : null}
            {cached ? <CachedBadge /> : null}
          </div>
          {description ? <p className="card-description">{description}</p> : null}
        </div>
        {headerExtra ? <div className="flex flex-wrap items-center gap-2">{headerExtra}</div> : null}
      </header>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/** What an empty panel says. Never "0" and never a blank space: an absent
 *  answer and an answer of zero are different facts, and the panel says which. */
export function AnalyticsEmpty({ reason }: { reason: string }) {
  return (
    <div className="empty flex flex-1 flex-col justify-center">
      <p className="empty-text">{reason}</p>
    </div>
  );
}

/** What a panel says while its own request is still in flight. Never an empty
 *  chart: "we have not been told" and "there is nothing" are different facts,
 *  and only one of them is a measurement. */
export function AnalyticsLoading({ what = "Загружаем…" }: { what?: string }) {
  return (
    <div className="empty flex flex-1 flex-col justify-center" aria-busy="true">
      <p className="empty-text">{what}</p>
    </div>
  );
}

const FAILED_TITLE = "Запрос не выполнен — данные не показаны.";

/** The server's own error text: kept for whoever debugs it, collapsed so a
 *  long validation dump does not become the panel. */
function ErrorDetails({ message }: { message: string }) {
  return (
    <details className="help">
      <summary>Технические детали</summary>
      <div className="help-body break-words text-xs">{message}</div>
    </details>
  );
}

/** What a panel says when its request FAILED — never an empty dataset, never a
 *  zero. The retry refetches that one query, not the page. `compact` is the
 *  one-line form for a block inside another card. */
export function AnalyticsError({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
  compact?: boolean | undefined;
}) {
  if (compact) {
    return (
      <div role="alert" className="notice notice-warning">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{FAILED_TITLE}</p>
          <ErrorDetails message={message} />
        </div>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="btn btn-sm">
            Повторить
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div role="alert" className="empty flex flex-1 flex-col items-center justify-center">
      <p className="empty-title">{FAILED_TITLE}</p>
      <div className="mt-2 max-w-[440px] text-left">
        <ErrorDetails message={message} />
      </div>
      {onRetry ? (
        <div className="empty-actions">
          <button type="button" onClick={onRetry} className="btn btn-sm">
            Повторить
          </button>
        </div>
      ) : null}
    </div>
  );
}
