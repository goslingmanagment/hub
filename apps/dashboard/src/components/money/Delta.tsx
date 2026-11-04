import type { MillsLike } from "@agency_hub_core/shared";
import { changeDirection, formatSignedMills, formatSignedPercent } from "@/lib/format";

/**
 * The change against the last period: «−$2,193.64 (−16 %)», the sum in the colour of
 * its direction and the percent quiet. On income and counters only: on costs the sum
 * stays in the main colour (`neutral`). A drop is not an alarm: never the status red.
 * Growth from zero has no percent; nothing to compare with is «—».
 */
export function MoneyDelta({ mills, pct, neutral = false, bare = false }: {
  mills: MillsLike | null | undefined;
  pct: number | null | undefined;
  neutral?: boolean;
  /** In a table's column: without the brackets, the percent as its second part. */
  bare?: boolean;
}) {
  if (mills === null || mills === undefined) {
    return (
      <span className="delta delta-pct">
        <span aria-hidden="true">—</span>
        <span className="sr-only">нет сравнения</span>
      </span>
    );
  }
  const direction = neutral ? "flat" : changeDirection(mills);
  const tone = direction === "up" ? "delta-up" : direction === "down" ? "delta-down" : "";
  const percent = pct === null || pct === undefined ? null : formatSignedPercent(pct);
  return (
    <span className="delta">
      <span className={tone}>{formatSignedMills(mills)}</span>
      {percent && <span className="delta-pct">{bare ? ` ${percent}` : ` (${percent})`}</span>}
    </span>
  );
}
