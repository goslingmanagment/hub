import type { ReactNode } from "react";

import type { CoverageVerdict } from "./coverage.js";

const BADGE_CLASS: Readonly<Record<CoverageVerdict["state"], string>> = {
  complete: "border-border text-text-muted",
  partial: "border-warning-dark/60 text-warning-dark",
  stale: "border-warning-dark/60 text-warning-dark",
  not_started: "border-border text-text-muted",
  unknown: "border-warning-dark/60 text-warning-dark",
  pending: "border-border text-text-muted",
  unavailable: "border-warning-dark/60 text-warning-dark",
  refresh_failed: "border-warning-dark/60 text-warning-dark",
};

/**
 * The badge that makes partial data impossible to mistake for complete data.
 *
 * It is rendered for every state EXCEPT `complete`, and a chart with no badge is
 * therefore a chart asserting its window is fully captured. Making the honest
 * case the loud one is deliberate: the failure this whole initiative exists to
 * prevent is a confident chart drawn over a hole.
 */
export function CoverageBadge({ verdict }: { verdict: CoverageVerdict }) {
  if (verdict.state === "complete") {
    return null;
  }
  return (
    <span
      title={verdict.detail}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        BADGE_CLASS[verdict.state]
      }`}
    >
      {verdict.label}
    </span>
  );
}

/**
 * One panel of the Analytics page: a titled card that carries its own coverage
 * verdict in the header, beside the title, where it cannot be scrolled past.
 */
export function AnalyticsPanel({
  title,
  subtitle,
  verdict,
  headerExtra,
  footnote,
  cached = false,
  children,
}: {
  title: string;
  subtitle?: string;
  verdict?: CoverageVerdict;
  headerExtra?: ReactNode;
  footnote?: string;
  /** True when this panel's own data is cached and its refresh failed. */
  cached?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">
            {title}
          </h2>
          {verdict ? <CoverageBadge verdict={verdict} /> : null}
          {cached ? (
            <span
              title="The refresh of this panel's own data failed. What is shown is the last successful response."
              className="rounded-full border border-warning-dark/60 px-2 py-0.5 text-[11px] font-medium text-warning-dark"
            >
              cached — refresh failed
            </span>
          ) : null}
        </div>
        {headerExtra}
      </header>
      {subtitle ? (
        <p className="mb-3 text-[12px] text-text-secondary">{subtitle}</p>
      ) : null}
      {children}
      {footnote ? (
        <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-text-muted">
          {footnote}
        </p>
      ) : null}
    </section>
  );
}

/** What an empty panel says. Never "0" and never a blank space: an absent
 *  answer and an answer of zero are different facts, and the panel says which. */
export function AnalyticsEmpty({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-text-muted">
      {reason}
    </div>
  );
}

/** What a panel says while its own request is still in flight. Never an empty
 *  chart: "we have not been told" and "there is nothing" are different facts,
 *  and only one of them is a measurement. */
export function AnalyticsLoading({ what = "Loading…" }: { what?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-text-muted">
      {what}
    </div>
  );
}

/** What a panel says when its request FAILED — never an empty dataset, never a
 *  zero. The retry refetches that one query, not the page. */
export function AnalyticsError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-warning-dark/60 px-4 py-6 text-center text-[13px]"
    >
      <p className="font-medium text-text-primary">This request failed — nothing is shown for it.</p>
      <p className="mt-1 text-[12px] text-text-muted">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
