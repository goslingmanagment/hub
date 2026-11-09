import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { formatAgo, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { Spinner } from "@agency_hub_core/ui";

/**
 * «Обновлено в 23:41, 5 мин назад»: when the screen's numbers were read. The
 * words are the refresh button (quiet, no separate «Обновить»). It ticks by
 * itself every half minute. A read again that failed (`stale`) says so in the
 * same place, warm, the numbers on the screen staying the last good ones.
 */
export function Freshness({ updatedAt, onRefresh, refreshing = false, stale = false }: {
  /** `dataUpdatedAt` of the screen's main read; 0 or undefined: nothing read yet. */
  updatedAt: number | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** The last read again failed: the screen shows the numbers of `updatedAt`. */
  stale?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!updatedAt) return null;
  const words = stale
    ? `Не обновилось — данные на ${formatTimeOfDay(updatedAt)}`
    : `Обновлено в ${formatTimeOfDay(updatedAt)}, ${formatAgo(updatedAt, Math.max(now, updatedAt))}`;
  const className = stale ? "wb-fresh wb-fresh--stale" : "wb-fresh";
  if (!onRefresh) return <span className={className} title={stale ? "Hub не ответил на повторное чтение; он спросится снова сам" : undefined}>{words}</span>;
  return (
    <button type="button" className={`${className} wb-fresh--button`} onClick={onRefresh} disabled={refreshing} title={stale ? "Hub не ответил. Попробовать сейчас" : "Обновить сейчас"}>
      {refreshing ? <Spinner /> : <RotateCw size={14} strokeWidth={1.75} aria-hidden />}
      {refreshing ? "Обновляем…" : words}
    </button>
  );
}
