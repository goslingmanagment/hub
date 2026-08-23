import type { ReactNode } from "react";

import type { CoverageVerdict } from "./coverage.js";

const BADGE_CLASS: Readonly<Record<CoverageVerdict["state"], string>> = {
  complete: "border-border text-text-muted",
  partial: "border-warning-dark/60 text-warning-dark",
  stale: "border-warning-dark/60 text-warning-dark",
  not_started: "border-border text-text-muted",
  unknown: "border-warning-dark/60 text-warning-dark",
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
  children,
}: {
  title: string;
  subtitle?: string;
  verdict?: CoverageVerdict;
  headerExtra?: ReactNode;
  footnote?: string;
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
