import type { ReactNode } from "react";
import { Skeleton, Tooltip } from "@agency_hub_core/ui";

/**
 * A screen's numbers in one row (the review's shift, the person's period): a
 * label, the number, and under it at most one quiet line — a change or a second
 * fact. The definition is a hint on the whole tile, never prose on the page.
 */
export interface Tile {
  label: string;
  value: ReactNode;
  /** The definition, a sentence or two, or a few rows of money; on hover. */
  hint: ReactNode;
  /** Under the value: «−36 %», «41 ч 24 мин». */
  sub?: ReactNode;
  /** Under the value: what it is made of, as one thin bar; each part's colour is its class. */
  bar?: ReadonlyArray<{ key: string; size: number; className: string }>;
}

export function Tiles({ tiles, label }: { tiles: readonly Tile[]; label: string }) {
  return (
    <div className="wb-tiles" role="list" aria-label={label}>
      {tiles.map((tile) => (
        <Tooltip key={tile.label} content={tile.hint} align="start" side="bottom" className="wb-tile__tip">
          <div className="wb-tile" role="listitem">
            <span className="wb-tile__label">{tile.label}</span>
            <span className="wb-tile__value">{tile.value}</span>
            {tile.sub !== undefined && tile.sub !== null && <span className="wb-tile__sub">{tile.sub}</span>}
            {tile.bar && tile.bar.length > 0 && (
              <span className="wb-tile__bar" aria-hidden>
                {tile.bar.map((part) => <i key={part.key} className={part.className} style={{ flexGrow: part.size }} />)}
              </span>
            )}
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

export function TilesSkeleton({ count = 6, sub = false }: { count?: number; sub?: boolean }) {
  return (
    <div className="wb-tiles" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="wb-tile">
          <Skeleton width={72} height={14} radius={4} />
          <Skeleton width={96} height={24} radius={6} />
          {sub && <Skeleton width={56} height={14} radius={4} />}
        </div>
      ))}
    </div>
  );
}
