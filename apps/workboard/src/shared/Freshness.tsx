import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { formatAgo, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { Spinner } from "@agency_hub_core/ui";

/**
 * «Обновлено в 23:41, 5 мин назад»: when the screen's numbers were read. The
 * words are the refresh button (quiet, no separate «Обновить»). It ticks by
 * itself every half minute.
 */
export function Freshness({ updatedAt, onRefresh, refreshing = false }: {
  /** `dataUpdatedAt` of the screen's main read; 0 or undefined: nothing read yet. */
  updatedAt: number | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!updatedAt) return null;
  const words = `Обновлено в ${formatTimeOfDay(updatedAt)}, ${formatAgo(updatedAt, Math.max(now, updatedAt))}`;
  if (!onRefresh) return <span className="wb-fresh">{words}</span>;
  return (
    <button type="button" className="wb-fresh wb-fresh--button" onClick={onRefresh} disabled={refreshing} title="Обновить сейчас">
      {refreshing ? <Spinner /> : <RotateCw size={14} strokeWidth={1.75} aria-hidden />}
      {refreshing ? "Обновляем…" : words}
    </button>
  );
}
