import { formatPct, signedMoney } from "./presentation.js";

/** The change against the previous window: signed dollars, then percent.
 *  Without a comparison it is a dash; without a non-zero base, no percent. */
export function RevenueDelta({
  deltaNetMills,
  deltaPct,
}: {
  deltaNetMills?: number | null | undefined;
  deltaPct?: number | null | undefined;
}) {
  if (deltaNetMills == null)
    return (
      <span className="ov-delta ov-delta-flat">
        <span aria-hidden="true">—</span>
        <span className="sr-only">нет сравнения</span>
      </span>
    );
  return (
    <span
      className={`ov-delta ${deltaNetMills === 0 ? "ov-delta-flat" : deltaNetMills < 0 ? "ov-delta-down" : "ov-delta-up"}`}
    >
      <span>{signedMoney(deltaNetMills)}</span>
      {deltaPct != null && (
        <span className="ov-delta-pct">{formatPct(deltaPct)}</span>
      )}
    </span>
  );
}
