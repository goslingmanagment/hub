import { useState, type ReactNode } from "react";

import { KINDS, money, percent, share, type Stats } from "./statsView.js";

// The quiet blocks around the ribbon: a whole split into kinds, rates against
// the team's, ranked bars. Plain HTML: each value is also printed beside its
// mark, so nothing waits behind a hover.

export function Card({ title, note, children, className = "" }: { title: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card cs-card ${className}`}>
      <header className="cs-card-head">
        <h2 className="card-title">{title}</h2>
        {note && <p className="cs-card-note">{note}</p>}
      </header>
      <div className="cs-card-body">{children}</div>
    </section>
  );
}

/** One whole in parts: the tall segmented bar, a share printed on each block that has room, the amounts listed under it. */
export function KindSplit({ byKind }: { byKind: Stats["totals"]["byKind"] }) {
  const total = KINDS.reduce((sum, kind) => sum + byKind[kind.key], 0);
  const parts = KINDS.map((kind) => ({ ...kind, mills: byKind[kind.key], share: share(byKind[kind.key], total) ?? 0 }));
  if (total <= 0) return <p className="cs-empty-line">Продаж за период нет.</p>;
  return (
    <div className="cs-split">
      <div className="cs-split-bar" role="img" aria-label={parts.filter((part) => part.mills > 0).map((part) => `${part.label} ${percent(part.share)}`).join(", ")}>
        {parts.filter((part) => part.mills > 0).map((part) => (
          <span key={part.key} className="cs-split-part" style={{ flexGrow: part.mills, background: part.color }} title={`${part.label}: ${money(part.mills)}`}>
            {part.share >= 0.12 && <span className="cs-split-share">{percent(part.share)}</span>}
          </span>
        ))}
      </div>
      <ul className="cs-split-list">
        {parts.map((part) => (
          <li key={part.key}>
            <span aria-hidden="true" className="cs-swatch" style={{ background: part.color }} />
            <span className="cs-split-name">{part.label}</span>
            <span className="cs-split-value">{money(part.mills)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface RateRow {
  key: string;
  label: string;
  /** Of `base`, how many came through (bought). */
  hits: number;
  base: number;
  teamHits: number;
  teamBase: number;
  /** What the row says beside its rate, e.g. «12 из 21». */
  detail: string;
}

/**
 * A rate per bucket, the chatter's against the team's: the chatter's as the
 * bar (the one that matters), the team's as a grey tick on the same track.
 * The scale is the largest rate shown, so the bars use the width.
 */
export function RateRows({ rows, empty, baseWord }: { rows: readonly RateRow[]; empty: string; baseWord: string }) {
  const [focus, setFocus] = useState<string | null>(null);
  const rates = rows.flatMap((row) => [share(row.hits, row.base), share(row.teamHits, row.teamBase)]).filter((rate): rate is number => rate !== null);
  if (rows.every((row) => row.base === 0)) return <p className="cs-empty-line">{empty}</p>;
  const top = Math.max(0.05, ...rates);
  return (
    <ul className="cs-rates">
      {rows.map((row) => {
        const mine = share(row.hits, row.base);
        const team = share(row.teamHits, row.teamBase);
        return (
          <li
            key={row.key}
            className="cs-rate"
            data-focus={focus === row.key || undefined}
            onPointerEnter={() => setFocus(row.key)}
            onPointerLeave={() => setFocus(null)}
          >
            <span className="cs-rate-label">{row.label}</span>
            <span className="cs-rate-track" aria-hidden="true">
              {mine !== null && <span className="cs-rate-bar" style={{ width: `${(mine / top) * 100}%` }} />}
              {team !== null && <span className="cs-rate-team" style={{ left: `${(team / top) * 100}%` }} title={`Команда: ${percent(team)}`} />}
            </span>
            <span className="cs-rate-value">
              <strong>{mine === null ? "—" : percent(mine)}</strong>
              <span>{row.base === 0 ? `не было ${baseWord}` : row.detail}</span>
            </span>
            {team !== null && <span className="cs-rate-team-value">команда {percent(team)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export interface RankedRow {
  key: string;
  label: ReactNode;
  value: number;
  valueText: string;
  detail?: string;
}

/** Ranked bars, one hue, the largest first: parts compared with each other. */
export function RankedRows({ rows, empty }: { rows: readonly RankedRow[]; empty: string }) {
  const top = Math.max(0, ...rows.map((row) => row.value));
  if (rows.length === 0 || top <= 0) return <p className="cs-empty-line">{empty}</p>;
  return (
    <ul className="cs-ranked">
      {rows.map((row) => (
        <li key={row.key} className="cs-ranked-row">
          <span className="cs-ranked-label">{row.label}</span>
          <span className="cs-ranked-value">
            <strong>{row.valueText}</strong>
            {row.detail && <span>{row.detail}</span>}
          </span>
          <span className="cs-ranked-track" aria-hidden="true">
            <span className="cs-ranked-bar" style={{ width: `${Math.max(row.value > 0 ? 1.5 : 0, (row.value / top) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
